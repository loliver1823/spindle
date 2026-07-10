package backend

import "testing"

func lm(title, artist, album string, durSecs int, extraArtists ...string) localMatchTrack {
	artists := map[string]bool{normalizeMatch(artist): true}
	for _, a := range extraArtists {
		artists[normalizeMatch(a)] = true
	}
	return localMatchTrack{
		track:         LibraryTrack{Title: title, Artist: artist, Album: album},
		normTitle:     normalizeMatch(title),
		normTitleCore: normalizeMatch(stripVersionTail(title)),
		variantSig:    variantSignature(title),
		featNames:     extractFeatNames(title),
		normArtists:   artists,
		normAlbum:     normalizeMatch(album),
		durationMs:    int64(durSecs) * 1000,
	}
}

func scoreRef(name string, artists []string, album string, durMs int64, l localMatchTrack) float64 {
	refArtists := map[string]bool{}
	for _, a := range artists {
		refArtists[normalizeMatch(a)] = true
	}
	return scoreMatch(normalizeMatch(name), normalizeMatch(stripVersionTail(name)), variantSignature(name), extractFeatNames(name), refArtists, normalizeMatch(album), durMs, &l)
}

func TestNormalizeMatchFoldsUnicodePunctuation(t *testing.T) {
	// Library tags carry U+2010 hyphens and curly apostrophes; Spotify sends ASCII.
	if normalizeMatch("blink‐182") != normalizeMatch("blink-182") {
		t.Error("U+2010 hyphen should fold to ASCII")
	}
	if normalizeMatch("M+M’s") != normalizeMatch("M+M's") {
		t.Error("curly apostrophe should fold to ASCII")
	}
}

func TestStripVersionTail(t *testing.T) {
	cases := map[string]string{
		"Down - Single Version":         "Down",
		"Josie - Radio Edit":            "Josie",
		"All The Small Things":          "All The Small Things",
		"Adam's Song (Remastered 2019)": "Adam's Song",
		"Greatest Hits [International Version (Explicit)]": "Greatest Hits",
	}
	for in, want := range cases {
		if got := stripVersionTail(in); got != want {
			t.Errorf("stripVersionTail(%q) = %q, want %q", in, got, want)
		}
	}
}

// The exact real-world misses: Greatest Hits playlist refs against library
// rows tagged with U+2010 in the artist and version suffixes in ref titles.
func TestScoreMatchRealWorldMisses(t *testing.T) {
	album := "Greatest Hits [International Version (Explicit)]"
	cases := []struct {
		name  string
		durMs int64
		local localMatchTrack
	}{
		{"Down - Single Version", 193000, lm("Down", "blink‐182", "Greatest Hits", 193)},
		{"Josie - Radio Edit", 185000, lm("Josie", "blink‐182", "Greatest Hits", 185)},
		{"M+M's", 155000, lm("M+M’s", "blink‐182", "Greatest Hits", 155)},
		{"Man Overboard", 166000, lm("Man Overboard", "blink‐182", "Greatest Hits", 166)},
	}
	for _, c := range cases {
		if s := scoreRef(c.name, []string{"blink-182"}, album, c.durMs, c.local); s < 0.5 {
			t.Errorf("%q vs %q scored %.2f — should match (>= 0.5)", c.name, c.local.track.Title, s)
		}
	}
}

// A live/remix/acoustic ref must never be satisfied by the studio recording
// (or vice versa) — different variant markers zero out the title score.
func TestScoreMatchVariantGuard(t *testing.T) {
	noMatch := []struct {
		name  string
		durMs int64
		local localMatchTrack
	}{
		{"Dammit - Live", 190000, lm("Dammit", "blink‐182", "Dude Ranch", 166)},
		{"All The Small Things", 171000, lm("All The Small Things (Live)", "blink‐182", "The Mark, Tom, and Travis Show", 174)},
		{"I Miss You (Acoustic)", 230000, lm("I Miss You", "blink‐182", "Greatest Hits", 227)},
		{"First Date - Remix", 180000, lm("First Date", "blink‐182", "Take Off Your Pants And Jacket", 171)},
	}
	for _, c := range noMatch {
		if s := scoreRef(c.name, []string{"blink-182"}, "whatever", c.durMs, c.local); s >= 0.5 {
			t.Errorf("%q vs %q scored %.2f — different recording, must NOT match", c.name, c.local.track.Title, s)
		}
	}
	// Same variant on both sides still matches (live ref ↔ live file).
	if s := scoreRef("Carousel - Live", []string{"blink-182"}, "The Mark, Tom, and Travis Show", 218000,
		lm("Carousel (Live)", "blink‐182", "The Mark, Tom, and Travis Show (The Enema Strikes Back!)", 218)); s < 0.5 {
		t.Errorf("live-vs-live scored %.2f — should match", s)
	}
	// A title that legitimately contains a variant word on both sides is fine.
	if s := scoreRef("Live While We're Young", []string{"One Direction"}, "Take Me Home", 200000,
		lm("Live While We're Young", "One Direction", "Take Me Home", 200)); s < 0.5 {
		t.Errorf("matching titles containing 'live' scored %.2f — should match", s)
	}
}

// The "This Is Taylor Swift" bug: with one library track by an artist, every
// other playlist track by that artist with a similar runtime hit exactly 0.5
// (0.4 artist + 0.1 duration) and matched despite sharing nothing in the
// title. Zero title similarity must mean zero match.
func TestScoreMatchRequiresTitleSimilarity(t *testing.T) {
	local := lm("Anti-Hero", "Taylor Swift", "Midnights", 200)
	for _, name := range []string{"Cruel Summer", "Shake It Off", "Blank Space"} {
		if s := scoreRef(name, []string{"Taylor Swift"}, "some album", 201000, local); s > 0 {
			t.Errorf("%q vs %q scored %.2f — no title overlap, must score 0", name, local.track.Title, s)
		}
	}
	// The song they actually have still matches.
	if s := scoreRef("Anti-Hero", []string{"Taylor Swift"}, "Midnights", 200000, local); s < 0.5 {
		t.Errorf("exact track scored %.2f — should match", s)
	}
}

// "Anti-Hero (feat. Bleachers)" is a remix — a different recording from
// "Anti-Hero". A guest named in one side's feat clause who isn't credited on
// the other side means no match; a guest credited on both sides still does.
func TestScoreMatchFeatGuard(t *testing.T) {
	// Playlist has the Bleachers remix; library has the plain song.
	if s := scoreRef("Anti-Hero (feat. Bleachers)", []string{"Taylor Swift", "Bleachers"}, "Midnights (The Til Dawn Edition)", 200000,
		lm("Anti-Hero", "Taylor Swift", "Midnights", 200)); s >= 0.5 {
		t.Errorf("remix vs plain scored %.2f — different recordings, must NOT match", s)
	}
	// Reverse: playlist has the plain song; library has the remix.
	if s := scoreRef("Anti-Hero", []string{"Taylor Swift"}, "Midnights", 200000,
		lm("Anti-Hero (feat. Bleachers)", "Taylor Swift", "Midnights (The Til Dawn Edition)", 200, "Bleachers")); s >= 0.5 {
		t.Errorf("plain vs remix scored %.2f — different recordings, must NOT match", s)
	}
	// Same recording: the guest in the ref's feat clause IS credited locally.
	if s := scoreRef("Where I Belong (feat. We The Kings)", []string{"State Champs", "Simple Plan", "We The Kings"}, "Where I Belong", 210000,
		lm("Where I Belong", "State Champs", "Where I Belong", 210, "Simple Plan", "We The Kings")); s < 0.5 {
		t.Errorf("same recording with credited guest scored %.2f — should match", s)
	}
}

// "Anthem" is a substring of "Anthem Part Two" but they are different songs —
// containment only earns title credit when the leftover words are version
// cruft ("Single Version", "Remastered"), not substantive title words.
func TestScoreMatchSubstringGuard(t *testing.T) {
	wrong := []struct{ ref, local string }{
		{"Anthem Part Two", "Anthem"},
		{"Anthem", "Anthem Part Two"},
		{"Song 2", "Song"},
	}
	for _, c := range wrong {
		if s := scoreRef(c.ref, []string{"blink-182"}, "whatever", 200000, lm(c.local, "blink‐182", "Greatest Hits", 200)); s >= 0.5 {
			t.Errorf("%q vs %q scored %.2f — different songs, must NOT match", c.ref, c.local, s)
		}
	}
	// Version-cruft leftovers still match: unbracketed qualifier tails.
	ok := []struct{ ref, local string }{
		{"Dammit Remastered", "Dammit"},
		{"Down Single Version", "Down"},
	}
	for _, c := range ok {
		if s := scoreRef(c.ref, []string{"blink-182"}, "Greatest Hits", 200000, lm(c.local, "blink‐182", "Greatest Hits", 200)); s < 0.5 {
			t.Errorf("%q vs %q scored %.2f — version qualifier only, should match", c.ref, c.local, s)
		}
	}
}
