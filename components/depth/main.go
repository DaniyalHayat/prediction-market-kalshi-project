package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	schema        = "predictir.depth-replay.v1"
	priceScale    = 100_000_000
	maxLineBytes  = 4_096
	maxInputBytes = 32 * 1024 * 1024
	maxQuotes     = 100_000
	maxMarkets    = 4_096
)

var (
	tickerPattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9._:-]{0,179}$`)
	timePattern   = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$`)
	pricePattern  = regexp.MustCompile(`^[01](\.[0-9]{1,8})?$`)
	scientific    = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})(\.[0-9]{1,8})?[eE][+-]?[0-9]{1,2}$`)
	decimalScale  = big.NewRat(priceScale, 1)
)

type observation struct {
	ticker string
	at     time.Time
	bid    int64
	ask    int64
}

type bookHistory struct {
	count  int
	first  observation
	latest observation
}

type marketSummary struct {
	Ticker           string    `json:"ticker"`
	Observations     int       `json:"observations"`
	FirstObservedAt  time.Time `json:"first_observed_at"`
	LatestObservedAt time.Time `json:"latest_observed_at"`
	FirstMidpoint    float64   `json:"first_midpoint"`
	LatestMidpoint   float64   `json:"latest_midpoint"`
	LatestSpread     float64   `json:"latest_spread"`
	MidpointChange   float64   `json:"midpoint_change"`
}

type replay struct {
	Schema     string          `json:"schema"`
	QuoteCount int             `json:"quote_count"`
	Markets    []marketSummary `json:"markets"`
}

func readPrice(raw json.RawMessage) (int64, error) {
	if !pricePattern.Match(raw) {
		if scientific.Match(raw) {
			price, ok := new(big.Rat).SetString(string(raw))
			if ok {
				price.Mul(price, decimalScale)
				if price.IsInt() && price.Num().IsInt64() && price.Num().Int64() <= priceScale {
					return price.Num().Int64(), nil
				}
			}
		}
		return 0, errors.New("prices must be numeric USD amounts from 0 to 1, with at most eight decimal places")
	}
	whole, fraction, _ := strings.Cut(string(raw), ".")
	fraction += strings.Repeat("0", 8-len(fraction))
	scaled, err := strconv.ParseInt(whole+fraction, 10, 64)
	if err != nil || scaled > priceScale {
		return 0, errors.New("prices must be between 0 and 1 USD")
	}
	return scaled, nil
}

func parseObservation(line []byte) (observation, error) {
	var quote observation
	var observedAt string
	fields := make(map[string]struct{}, 4)
	dec := json.NewDecoder(bytes.NewReader(line))
	if token, err := dec.Token(); err != nil || token != json.Delim('{') {
		return quote, errors.New("expected one JSON object")
	}
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return quote, errors.New("invalid JSON field")
		}
		field, ok := token.(string)
		if !ok {
			return quote, errors.New("invalid JSON field")
		}
		if _, duplicate := fields[field]; duplicate {
			return quote, errors.New("duplicate quote field")
		}
		fields[field] = struct{}{}
		switch field {
		case "ticker":
			err = dec.Decode(&quote.ticker)
		case "observed_at":
			err = dec.Decode(&observedAt)
		case "yes_bid", "yes_ask":
			var raw json.RawMessage
			if err = dec.Decode(&raw); err == nil {
				var price int64
				price, err = readPrice(raw)
				if field == "yes_bid" {
					quote.bid = price
				} else {
					quote.ask = price
				}
			}
			if err != nil {
				return quote, fmt.Errorf("invalid %s price", field)
			}
		default:
			return quote, errors.New("unknown quote field")
		}
		if err != nil {
			return quote, fmt.Errorf("invalid %s value", field)
		}
	}
	if token, err := dec.Token(); err != nil || token != json.Delim('}') {
		return quote, errors.New("incomplete JSON object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return quote, errors.New("expected only one JSON object per line")
	}
	if len(fields) != 4 {
		return quote, errors.New("ticker, observed_at, yes_bid and yes_ask are required")
	}
	if !tickerPattern.MatchString(quote.ticker) {
		return quote, errors.New("expected an exact uppercase ticker")
	}
	if !timePattern.MatchString(observedAt) {
		return quote, errors.New("observed_at must be an RFC3339 timestamp with a time zone")
	}
	at, err := time.Parse(time.RFC3339Nano, observedAt)
	if err != nil || at.UTC().Year() < 1 || at.UTC().Year() > 9999 {
		return quote, errors.New("invalid observation timestamp")
	}
	quote.at = at.UTC()
	if quote.bid > quote.ask {
		return quote, errors.New("crossed quote")
	}
	return quote, nil
}

func summarize(in io.Reader) (replay, error) {
	result := replay{Schema: schema}
	books := make(map[string]bookHistory)
	limit := &io.LimitedReader{R: in, N: maxInputBytes + 1}
	scanner := bufio.NewScanner(limit)
	scanner.Buffer(make([]byte, maxLineBytes), maxLineBytes)
	for scanner.Scan() {
		result.QuoteCount++
		if result.QuoteCount > maxQuotes {
			return replay{}, fmt.Errorf("quote limit exceeded (%d)", maxQuotes)
		}
		if limit.N == 0 {
			return replay{}, fmt.Errorf("input exceeds %d bytes", maxInputBytes)
		}
		quote, err := parseObservation(scanner.Bytes())
		if err != nil {
			return replay{}, fmt.Errorf("line %d: %w", result.QuoteCount, err)
		}
		history, exists := books[quote.ticker]
		if exists {
			if !quote.at.After(history.latest.at) {
				return replay{}, fmt.Errorf("line %d: timestamps must strictly increase per ticker", result.QuoteCount)
			}
		} else {
			if len(books) == maxMarkets {
				return replay{}, fmt.Errorf("market limit exceeded (%d)", maxMarkets)
			}
			history.first = quote
		}
		history.count++
		history.latest = quote
		books[quote.ticker] = history
	}
	if err := scanner.Err(); err != nil {
		return replay{}, fmt.Errorf("input read failed near line %d (maximum %d bytes per line): %w", result.QuoteCount+1, maxLineBytes, err)
	}
	if result.QuoteCount == 0 {
		return replay{}, errors.New("provide at least one quote")
	}
	tickers := make([]string, 0, len(books))
	for ticker := range books {
		tickers = append(tickers, ticker)
	}
	slices.Sort(tickers)
	result.Markets = make([]marketSummary, 0, len(tickers))
	for _, ticker := range tickers {
		history := books[ticker]
		first := history.first.bid + history.first.ask
		latest := history.latest.bid + history.latest.ask
		result.Markets = append(result.Markets, marketSummary{
			Ticker: ticker, Observations: history.count,
			FirstObservedAt: history.first.at, LatestObservedAt: history.latest.at,
			FirstMidpoint:  float64(first) / (2 * priceScale),
			LatestMidpoint: float64(latest) / (2 * priceScale),
			LatestSpread:   float64(history.latest.ask-history.latest.bid) / priceScale,
			MidpointChange: float64(latest-first) / (2 * priceScale),
		})
	}
	return result, nil
}

func run(in io.Reader, out io.Writer) error {
	result, err := summarize(in)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(result)
}

func main() {
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: depth < quotes.jsonl")
		os.Exit(2)
	}
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "depth: %v\n", err)
		os.Exit(1)
	}
}
