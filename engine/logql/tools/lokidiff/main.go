// lokidiff: black-box differential harness for viz-logql.
//
// It evaluates the queries of a case file (written by viz-logql's exporter,
// `cargo test --release --test differential export_cases -- --ignored`) with
// Grafana Loki's LogQL engine, called only through its exported Go API, and
// compares the `data` object of Loki's HTTP API response with the one viz wrote.
//
// THIS PROGRAM LINKS AGPL-3.0 CODE (Grafana Loki). It is a test tool only. It is
// built by run.sh in a scratch directory, from Loki fetched through the Go module
// proxy at a pinned tag; neither Loki's source nor this program's binary is ever
// committed or shipped in any viz artifact. See README.md and ../../CLEANROOM.md.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	kitlog "github.com/go-kit/log"
	"github.com/grafana/dskit/user"

	"github.com/grafana/loki/v3/pkg/logproto"
	"github.com/grafana/loki/v3/pkg/logql"
	"github.com/grafana/loki/v3/pkg/util/marshal"
)

type entry struct {
	Ts   string            `json:"ts"` // nanoseconds, decimal
	Line string            `json:"line"`
	Meta map[string]string `json:"meta,omitempty"`
}

type stream struct {
	Labels  map[string]string `json:"labels"`
	Entries []entry           `json:"entries"`
}

type tcase struct {
	ID        int             `json:"id"`
	Dataset   int             `json:"dataset"`
	Query     string          `json:"query"`
	Instant   bool            `json:"instant"`
	Start     string          `json:"start"`
	End       string          `json:"end"`
	Step      string          `json:"step"`
	Direction string          `json:"direction"`
	Limit     uint32          `json:"limit"`
	VizOK     bool            `json:"viz_ok"`
	VizErr    string          `json:"viz_err"`
	VizData   json.RawMessage `json:"viz_data"`
	Feature   string          `json:"feature"`
}

type caseFile struct {
	Datasets [][]stream `json:"datasets"`
	Cases    []tcase    `json:"cases"`
}

type outcome struct {
	ID      int    `json:"id"`
	Feature string `json:"feature"`
	Query   string `json:"query"`
	Instant bool   `json:"instant"`
	Verdict string `json:"verdict"` // agree, both_error, mismatch
	Detail  string `json:"detail,omitempty"`
	LokiErr string `json:"loki_err,omitempty"`
	VizErr  string `json:"viz_err,omitempty"`
	Loki    json.RawMessage `json:"loki,omitempty"`
	Viz     json.RawMessage `json:"viz,omitempty"`
}

func labelString(m map[string]string) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("{")
	for i, k := range keys {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(k)
		b.WriteString("=")
		b.WriteString(strconv.Quote(m[k]))
	}
	b.WriteString("}")
	return b.String()
}

func toStreams(ds []stream) []logproto.Stream {
	out := make([]logproto.Stream, 0, len(ds))
	for _, s := range ds {
		ls := logproto.Stream{Labels: labelString(s.Labels)}
		for _, e := range s.Entries {
			ns, err := strconv.ParseInt(e.Ts, 10, 64)
			if err != nil {
				panic(err)
			}
			en := logproto.Entry{Timestamp: time.Unix(0, ns).UTC(), Line: e.Line}
			keys := make([]string, 0, len(e.Meta))
			for k := range e.Meta {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				en.StructuredMetadata = append(en.StructuredMetadata, logproto.LabelAdapter{Name: k, Value: e.Meta[k]})
			}
			ls.Entries = append(ls.Entries, en)
		}
		out = append(out, ls)
	}
	return out
}

func parseNs(s string) int64 {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		panic(err)
	}
	return v
}

func runLoki(q logql.Querier, c tcase) (json.RawMessage, error) {
	eng := logql.NewEngine(logql.EngineOpts{}, q, logql.NoLimits, kitlog.NewNopLogger())
	dir := logproto.FORWARD
	if c.Direction == "backward" {
		dir = logproto.BACKWARD
	}
	start := time.Unix(0, parseNs(c.Start)).UTC()
	end := time.Unix(0, parseNs(c.End)).UTC()
	step := time.Duration(parseNs(c.Step))
	if c.Instant {
		step = 0
	}
	params, err := logql.NewLiteralParams(c.Query, start, end, step, 0, dir, c.Limit, nil, nil)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(user.InjectOrgID(context.Background(), "fake"), 60*time.Second)
	defer cancel()
	res, err := eng.Query(params).Exec(ctx)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := marshal.WriteQueryResponseJSON(res.Data, res.Warnings, res.Statistics, &buf, nil); err != nil {
		return nil, err
	}
	var full struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(buf.Bytes(), &full); err != nil {
		return nil, err
	}
	return full.Data, nil
}

// ---- comparison ----

type data struct {
	ResultType string          `json:"resultType"`
	Result     json.RawMessage `json:"result"`
}

type streamV struct {
	Stream map[string]string `json:"stream"`
	Values [][2]string       `json:"values"`
}

type seriesV struct {
	Metric map[string]string `json:"metric"`
	Values [][2]interface{}  `json:"values"`
	Value  [2]interface{}    `json:"value"`
}

func num(v interface{}) (float64, error) {
	switch x := v.(type) {
	case float64:
		return x, nil
	case string:
		switch x {
		case "NaN":
			return math.NaN(), nil
		case "+Inf", "Inf":
			return math.Inf(1), nil
		case "-Inf":
			return math.Inf(-1), nil
		}
		return strconv.ParseFloat(x, 64)
	case json.Number:
		return x.Float64()
	}
	return 0, fmt.Errorf("not a number: %v", v)
}

func feq(a, b float64) bool {
	if math.IsNaN(a) && math.IsNaN(b) {
		return true
	}
	if a == b {
		return true
	}
	d := math.Abs(a - b)
	m := math.Max(math.Abs(a), math.Abs(b))
	return d <= 1e-9*m || d < 1e-12
}

func pointsEqual(a, b [][2]interface{}) string {
	if len(a) != len(b) {
		return fmt.Sprintf("point count %d vs %d", len(a), len(b))
	}
	for i := range a {
		ta, _ := num(a[i][0])
		tb, _ := num(b[i][0])
		if math.Abs(ta-tb) > 1e-6 {
			return fmt.Sprintf("point %d time %v vs %v", i, a[i][0], b[i][0])
		}
		va, ea := num(a[i][1])
		vb, eb := num(b[i][1])
		if ea != nil || eb != nil || !feq(va, vb) {
			return fmt.Sprintf("point %d value %v vs %v", i, a[i][1], b[i][1])
		}
	}
	return ""
}

func ordered(q string) bool {
	return strings.Contains(q, "sort") || strings.Contains(q, "topk") || strings.Contains(q, "bottomk")
}

func compare(c tcase, loki, viz json.RawMessage) string {
	var dl, dv data
	if err := json.Unmarshal(loki, &dl); err != nil {
		return "loki json: " + err.Error()
	}
	if err := json.Unmarshal(viz, &dv); err != nil {
		return "viz json: " + err.Error()
	}
	if dl.ResultType != dv.ResultType {
		return fmt.Sprintf("resultType %s vs %s", dl.ResultType, dv.ResultType)
	}
	switch dl.ResultType {
	case "streams":
		var sl, sv []streamV
		if err := json.Unmarshal(dl.Result, &sl); err != nil {
			return err.Error()
		}
		if err := json.Unmarshal(dv.Result, &sv); err != nil {
			return err.Error()
		}
		key := func(s []streamV) map[string]streamV {
			m := map[string]streamV{}
			for _, x := range s {
				m[labelString(x.Stream)] = x
			}
			return m
		}
		ml, mv := key(sl), key(sv)
		if len(ml) != len(sl) || len(mv) != len(sv) {
			return "duplicate stream label sets"
		}
		if len(ml) != len(mv) {
			return fmt.Sprintf("stream count %d vs %d", len(ml), len(mv))
		}
		for k, a := range ml {
			b, ok := mv[k]
			if !ok {
				return "stream missing in viz: " + k
			}
			if len(a.Values) != len(b.Values) {
				return fmt.Sprintf("stream %s: %d vs %d entries", k, len(a.Values), len(b.Values))
			}
			for i := range a.Values {
				if a.Values[i] != b.Values[i] {
					return fmt.Sprintf("stream %s entry %d: %q vs %q", k, i, a.Values[i], b.Values[i])
				}
			}
		}
		return ""
	case "matrix", "vector":
		var sl, sv []seriesV
		if err := json.Unmarshal(dl.Result, &sl); err != nil {
			return err.Error()
		}
		if err := json.Unmarshal(dv.Result, &sv); err != nil {
			return err.Error()
		}
		if len(sl) != len(sv) {
			return fmt.Sprintf("series count %d vs %d", len(sl), len(sv))
		}
		keep := dl.ResultType == "vector" && ordered(c.Query)
		if !keep {
			sort.Slice(sl, func(i, j int) bool { return labelString(sl[i].Metric) < labelString(sl[j].Metric) })
			sort.Slice(sv, func(i, j int) bool { return labelString(sv[i].Metric) < labelString(sv[j].Metric) })
		}
		for i := range sl {
			kl, kv := labelString(sl[i].Metric), labelString(sv[i].Metric)
			if kl != kv {
				return fmt.Sprintf("series %d labels %s vs %s", i, kl, kv)
			}
			if dl.ResultType == "vector" {
				if d := pointsEqual([][2]interface{}{sl[i].Value}, [][2]interface{}{sv[i].Value}); d != "" {
					return kl + ": " + d
				}
			} else if d := pointsEqual(sl[i].Values, sv[i].Values); d != "" {
				return kl + ": " + d
			}
		}
		return ""
	case "scalar":
		var al, av [2]interface{}
		if err := json.Unmarshal(dl.Result, &al); err != nil {
			return err.Error()
		}
		if err := json.Unmarshal(dv.Result, &av); err != nil {
			return err.Error()
		}
		return pointsEqual([][2]interface{}{al}, [][2]interface{}{av})
	}
	return "unknown resultType " + dl.ResultType
}

func main() {
	probe := len(os.Args) == 4 && os.Args[1] == "probe"
	if probe {
		os.Args = os.Args[1:]
	}
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: lokidiff [probe] <cases.json> <report.json>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var cf caseFile
	if err := json.Unmarshal(raw, &cf); err != nil {
		panic(err)
	}
	queriers := make([]logql.Querier, len(cf.Datasets))
	for i, ds := range cf.Datasets {
		queriers[i] = logql.NewMockQuerier(1, toStreams(ds))
	}
	var outs []outcome
	counts := map[string]int{}
	for _, c := range cf.Cases {
		o := outcome{ID: c.ID, Feature: c.Feature, Query: c.Query, Instant: c.Instant, VizErr: c.VizErr}
		var lokiData json.RawMessage
		var lerr error
		func() {
			defer func() {
				if r := recover(); r != nil {
					lerr = fmt.Errorf("loki panic: %v", r)
				}
			}()
			lokiData, lerr = runLoki(queriers[c.Dataset], c)
		}()
		switch {
		case probe:
			// Observation only: record what Loki returns.
			o.Verdict = "observed"
			o.Loki = lokiData
			if lerr != nil {
				o.LokiErr = lerr.Error()
			}
		case lerr != nil && !c.VizOK:
			o.Verdict = "both_error"
			o.LokiErr = lerr.Error()
		case lerr != nil:
			o.Verdict = "mismatch"
			o.LokiErr = lerr.Error()
			o.Detail = "loki error, viz ok"
			o.Viz = c.VizData
		case !c.VizOK:
			o.Verdict = "mismatch"
			o.Detail = "viz error, loki ok"
			o.Loki = lokiData
		default:
			if d := compare(c, lokiData, c.VizData); d != "" {
				o.Verdict = "mismatch"
				o.Detail = d
				o.Loki = lokiData
				o.Viz = c.VizData
			} else {
				o.Verdict = "agree"
			}
		}
		counts[o.Verdict]++
		outs = append(outs, o)
	}
	rep, _ := json.MarshalIndent(map[string]interface{}{"counts": counts, "cases": outs}, "", " ")
	if err := os.WriteFile(os.Args[2], rep, 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("cases %d: agree %d, both_error %d, mismatch %d\n", len(outs), counts["agree"], counts["both_error"], counts["mismatch"])
}
