// Command godiff compares viz-goregex with Go's own regexp package (standard library only).
//
// Usage: go run . cases.json
//
// The case file is written by `cargo test --test go_differential -- --ignored` (README). For
// every pattern Go compiles the pattern alone (does Go accept it?) and, if it does, runs it
// fully anchored with `.` matching a newline (as TraceQL and label matchers use it) on every
// subject. It prints each case where viz differs (acceptance or matches) and a summary,
// and exits 1 if any differs. Patterns viz reports as Unsupported (Unicode classes) are counted
// and not compared. Where the case file has viz's group names (a caller that keeps names), they
// must be Go's SubexpNames, or Unsupported exactly where Go has a name Rust cannot hold (one that
// starts with a digit, or a name used twice).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
)

type answer struct {
	Matches          *string   `json:"matches"`
	Error            *string   `json:"error"`
	Unsupported      bool      `json:"unsupported"`
	Names            *[]string `json:"names"`
	NamesUnsupported bool      `json:"names_unsupported"`
	NamesError       *string   `json:"names_error"`
}

type file struct {
	Subjects []string `json:"subjects"`
	Cases    []struct {
		Pattern string `json:"pattern"`
		Viz     answer `json:"viz"`
	} `json:"cases"`
}

func main() {
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var f file
	if err := json.Unmarshal(raw, &f); err != nil {
		panic(err)
	}
	var agreeOK, agreeErr, unsupported, unsupportedGoErr, surrogates, differ, namesSame, namesUnsupported int
	surrogate := regexp.MustCompile(`(?i)\\x\{0*d[89a-f][0-9a-f]{2}\}`)
	for _, c := range f.Cases {
		goRe, goErr := regexp.Compile(c.Pattern)
		if c.Viz.Unsupported {
			unsupported++
			if goErr != nil {
				unsupportedGoErr++
			}
			continue
		}
		if goErr != nil {
			if c.Viz.Error != nil {
				agreeErr++
			} else {
				differ++
				fmt.Printf("DIFF %q: Go rejects (%v), viz accepts\n", c.Pattern, goErr)
			}
			continue
		}
		if c.Viz.Error != nil {
			differ++
			fmt.Printf("DIFF %q: Go accepts, viz rejects (%s)\n", c.Pattern, *c.Viz.Error)
			continue
		}
		// Group names as a caller that keeps them sees them.
		goNames := goRe.SubexpNames()[1:]
		unholdable := false
		seen := map[string]bool{}
		for _, n := range goNames {
			if n != "" && (n[0] >= '0' && n[0] <= '9' || seen[n]) {
				unholdable = true
			}
			seen[n] = true
		}
		switch {
		case c.Viz.NamesError != nil:
			differ++
			fmt.Printf("DIFF %q: Go accepts, viz keeping names rejects (%s)\n", c.Pattern, *c.Viz.NamesError)
			continue
		case c.Viz.NamesUnsupported:
			if !unholdable {
				differ++
				fmt.Printf("DIFF %q: viz keeping names says Unsupported; Go's names %q\n", c.Pattern, goNames)
				continue
			}
			namesUnsupported++
		case c.Viz.Names != nil:
			if unholdable || strings.Join(goNames, "\x00") != strings.Join(*c.Viz.Names, "\x00") || len(goNames) != len(*c.Viz.Names) {
				differ++
				fmt.Printf("DIFF %q: group names differ: go=%q viz=%q\n", c.Pattern, goNames, *c.Viz.Names)
				continue
			}
			namesSame++
		}
		// Fully anchored with `.` matching a newline. "^(?s:" + p + ")$" with MatchString is what
		// Tempo's answers agree with (it matches U+FFFD for \x{D800}, as Tempo does; Go's
		// leftmost-longest search does not). Where an unterminated \Q swallows the closing
		// parenthesis, the wrapped text does not compile: then leftmost-longest, with the match
		// required to span the subject (a full match exists exactly when that match is one).
		full, wrapErr := regexp.Compile("^(?s:" + c.Pattern + ")$")
		matches := func(s string) bool { return full.MatchString(s) }
		if wrapErr != nil {
			re := regexp.MustCompile("(?s)" + c.Pattern)
			re.Longest()
			matches = func(s string) bool { m := re.FindStringIndex(s); return m != nil && m[0] == 0 && m[1] == len(s) }
		}
		var b strings.Builder
		for _, s := range f.Subjects {
			if matches(s) {
				b.WriteByte('1')
			} else {
				b.WriteByte('0')
			}
		}
		if b.String() == *c.Viz.Matches {
			agreeOK++
			continue
		}
		var only []string
		fffdOnly := true
		for i, s := range f.Subjects {
			g, v := b.String()[i], (*c.Viz.Matches)[i]
			if g != v {
				only = append(only, fmt.Sprintf("%q go=%c viz=%c", s, g, v))
				fffdOnly = fffdOnly && s == "\uFFFD"
			}
		}
		// Go's answer for a surrogate escape depends on the pattern's shape: \x{D800} and
		// [\x{D800}a] match U+FFFD, ^\x{D800} and [\x{D800}ſA] do not. viz applies one rule (a
		// single surrogate matches U+FFFD, as Tempo's answers for the simple forms show), so
		// these are listed apart, not counted as differences.
		if fffdOnly && surrogate.MatchString(c.Pattern) {
			surrogates++
			fmt.Printf("SURROGATE %q: %s\n", c.Pattern, strings.Join(only, ", "))
			continue
		}
		differ++
		fmt.Printf("DIFF %q: matches differ: %s\n", c.Pattern, strings.Join(only, ", "))
	}
	fmt.Printf("%d patterns: %d accepted by both with identical matches on %d subjects, %d rejected by both, %d Unsupported in viz (%d of them rejected by Go), %d differ only on U+FFFD through a surrogate escape, %d differ\n",
		len(f.Cases), agreeOK, len(f.Subjects), agreeErr, unsupported, unsupportedGoErr, surrogates, differ)
	fmt.Printf("names kept: %d with Go's group names, %d Unsupported (a name Rust cannot hold: a leading digit or a repeat)\n", namesSame, namesUnsupported)
	if differ > 0 {
		os.Exit(1)
	}
}
