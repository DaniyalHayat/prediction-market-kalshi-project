package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

const firstQuote = `{"ticker":"KX-A","observed_at":"2026-11-06T10:00:00Z","yes_bid":0.31,"yes_ask":0.37}`

func TestDepthReplayPreservesContractOrderAndDecimalArithmetic(t *testing.T) {
	rows := []string{
		`{"ticker":"KX-B","observed_at":"2026-11-06T10:05:00Z","yes_bid":0.71,"yes_ask":0.75}`,
		firstQuote,
		`{"ticker":"KX-A","observed_at":"2026-11-06T05:01:00.123456789-05:00","yes_bid":0.37,"yes_ask":0.39}`,
		`{"ticker":"KX-B","observed_at":"2026-11-06T10:07:00Z","yes_bid":0.70,"yes_ask":0.73}`,
		`{"ticker":"KX-C","observed_at":"2026-11-06T10:08:00Z","yes_bid":1e-8,"yes_ask":0.00000002}`,
	}
	var out bytes.Buffer
	if err := run(strings.NewReader(strings.Join(rows, "\r\n")), &out); err != nil {
		t.Fatal(err)
	}
	var got replay
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Schema != schema || got.QuoteCount != 5 || len(got.Markets) != 3 {
		t.Fatalf("unexpected replay: %s", &out)
	}
	a, b, c := got.Markets[0], got.Markets[1], got.Markets[2]
	if a.Ticker != "KX-A" || a.Observations != 2 || a.FirstMidpoint != .34 || a.LatestMidpoint != .38 ||
		a.LatestSpread != .02 || a.MidpointChange != .04 ||
		a.LatestObservedAt.Format(time.RFC3339Nano) != "2026-11-06T10:01:00.123456789Z" {
		t.Fatalf("unexpected first market: %+v", a)
	}
	if b.Ticker != "KX-B" || b.Observations != 2 || b.MidpointChange != -.015 {
		t.Fatalf("unexpected second market: %+v", b)
	}
	if c.Ticker != "KX-C" || c.Observations != 1 || c.LatestMidpoint != .000000015 || c.LatestSpread != .00000001 || c.MidpointChange != 0 {
		t.Fatalf("unexpected sub-cent market: %+v", c)
	}
}

func TestDepthReplayRejectsBadRowsWithoutPublishingPartialResults(t *testing.T) {
	timestamp := "2026-11-06T10:01:00Z"
	validNext := fmt.Sprintf(`{"ticker":"KX-A","observed_at":%q,"yes_bid":0.5,"yes_ask":0.6}`, timestamp)
	cases := map[string]string{
		"bad date":               strings.Replace(validNext, "11-06", "11-31", 1),
		"blank line":             "",
		"case changed":           strings.Replace(validNext, "KX-A", "kx-a", 1),
		"crossed quote":          strings.Replace(validNext, "0.6", "0.49999999", 1),
		"descending timestamp":   strings.Replace(validNext, "10:01", "09:59", 1),
		"same instant":           strings.Replace(validNext, timestamp, "2026-11-06T05:00:00-05:00", 1),
		"duplicate ticker key":   strings.Replace(validNext, `"ticker":`, `"ticker":"KX-B","ticker":`, 1),
		"numeric string":         strings.Replace(validNext, "0.6", `"0.6"`, 1),
		"null price":             strings.Replace(validNext, "0.6", "null", 1),
		"null ticker":            strings.Replace(validNext, `"KX-A"`, "null", 1),
		"out of range":           strings.Replace(validNext, "0.6", "1.00000001", 1),
		"extra precision":        strings.Replace(validNext, "0.6", "0.600000001", 1),
		"unbounded exponent":     strings.Replace(validNext, "0.6", "6e9999", 1),
		"sub-precision exponent": strings.Replace(validNext, "0.6", "6e-9", 1),
		"unknown key":            strings.Replace(validNext, "yes_bid", "YES_BID", 1),
		"missing key":            strings.Replace(validNext, `,"yes_bid":0.5`, "", 1),
		"unexpected array":       "[]",
		"multiple JSON objects":  validNext + " {}",
		"missing time zone":      strings.Replace(validNext, timestamp, "2026-11-06T10:01:00", 1),
		"bad time zone":          strings.Replace(validNext, timestamp, "2026-11-06T10:01:00+00:60", 1),
		"oversized line":         validNext + strings.Repeat(" ", maxLineBytes),
	}
	for name, row := range cases {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			if err := run(strings.NewReader(firstQuote+"\n"+row+"\n"), &out); err == nil || out.Len() != 0 {
				t.Fatalf("expected no output on invalid row, got %q with error %v", &out, err)
			}
		})
	}
}

func TestDepthReplayRejectsEmptyInputAndTooManyMarkets(t *testing.T) {
	if _, err := summarize(strings.NewReader("")); err == nil {
		t.Fatal("empty input must fail")
	}
	var rows strings.Builder
	for i := range maxMarkets + 1 {
		fmt.Fprintf(&rows, `{"ticker":"KX-%d","observed_at":"2026-11-06T10:00:00Z","yes_bid":0,"yes_ask":1}`+"\n", i)
	}
	if _, err := summarize(strings.NewReader(rows.String())); err == nil || !strings.Contains(err.Error(), "market limit exceeded") {
		t.Fatalf("unexpected market limit error: %v", err)
	}
}
