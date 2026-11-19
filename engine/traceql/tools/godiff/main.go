// Command godiff evaluates TraceQL queries with Grafana Tempo's own engine and storage, as a
// black box, over data sets exported by viz-traceql, and writes Tempo's answers as JSON.
//
// THIS PROGRAM LINKS GRAFANA TEMPO, WHICH IS AGPL-3.0. It is a test harness only: it is
// fetched and built at test time through the Go module proxy, it is never part of any viz
// artifact, and nothing it links is committed to the repository. See README.md here.
//
// It uses only Tempo's exported Go API (as documented on pkg.go.dev): it writes the traces
// into a real vParquet5 block with the backend's local driver, opens the block, and runs
// the query engine over the block's fetcher, the way a querier does. It was written without
// reading Tempo's implementation.
//
// Usage:
//
//	godiff -cases cases.json -out tempo.json
//	godiff -probe            # prints Tempo's request alignment and default step for a few ranges
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gogo/protobuf/jsonpb"
	"github.com/google/uuid"
	"github.com/grafana/tempo/pkg/tempopb"
	v1common "github.com/grafana/tempo/pkg/tempopb/common/v1"
	v1resource "github.com/grafana/tempo/pkg/tempopb/resource/v1"
	v1trace "github.com/grafana/tempo/pkg/tempopb/trace/v1"
	"github.com/grafana/tempo/pkg/traceql"
	"github.com/grafana/tempo/tempodb/backend"
	"github.com/grafana/tempo/tempodb/backend/local"
	"github.com/grafana/tempo/tempodb/encoding"
	"github.com/grafana/tempo/tempodb/encoding/common"
	"github.com/grafana/tempo/tempodb/encoding/vparquet5"
)

// ---- input format (written by viz-traceql's exporter, tests/differential.rs) ----

type Attr struct {
	Key   string   `json:"key"`
	Type  string   `json:"type"` // str int float bool str_array int_array float_array bool_array
	Value string   `json:"value,omitempty"`
	Array []string `json:"array,omitempty"`
}

type Event struct {
	Time  string `json:"time"`
	Name  string `json:"name"`
	Attrs []Attr `json:"attrs"`
}

type Link struct {
	TraceID    string `json:"trace_id"`
	SpanID     string `json:"span_id"`
	TraceState string `json:"trace_state"`
	Attrs      []Attr `json:"attrs"`
}

type Span struct {
	TraceID       string  `json:"trace_id"`
	SpanID        string  `json:"span_id"`
	ParentSpanID  string  `json:"parent_span_id"`
	Name          string  `json:"name"`
	Kind          int32   `json:"kind"`
	StatusCode    int32   `json:"status_code"`
	StatusMessage string  `json:"status_message"`
	Start         string  `json:"start"`
	End           string  `json:"end"`
	Resource      int     `json:"resource"`
	Scope         int     `json:"scope"`
	Attrs         []Attr  `json:"attrs"`
	Events        []Event `json:"events"`
	Links         []Link  `json:"links"`
}

type Scope struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Attrs   []Attr `json:"attrs"`
}

type Dataset struct {
	Resources [][]Attr `json:"resources"`
	Scopes    []Scope  `json:"scopes"`
	Spans     []Span   `json:"spans"`
}

type Case struct {
	ID      int    `json:"id"`
	Dataset int    `json:"dataset"`
	Kind    string `json:"kind"` // search | range | instant
	Query   string `json:"query"`
	Limit   uint32 `json:"limit"`
	Spss    uint32 `json:"spss"`
	Start   uint64 `json:"start"` // search: unix seconds; metrics: unix nanoseconds
	End     uint64 `json:"end"`
	Step    uint64 `json:"step"`
	// Viz's own answer (JSON text). The harness checks that Tempo's protobuf types decode it.
	Viz json.RawMessage `json:"viz,omitempty"`
}

type Input struct {
	Datasets []Dataset `json:"datasets"`
	Cases    []Case    `json:"cases"`
}

type Output struct {
	ID int `json:"id"`
	// Tempo's response rendered with gogo jsonpb, or the error it returned.
	Tempo json.RawMessage `json:"tempo,omitempty"`
	Error string          `json:"error,omitempty"`
	// Whether viz's JSON decodes strictly into Tempo's response type ("" = ok).
	VizDecode string `json:"viz_decode,omitempty"`
}

// ---- conversion to OTLP protobuf types ----

func mustHex(s string, n int) []byte {
	if s == "" {
		return nil
	}
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != n {
		panic(fmt.Sprintf("bad hex id %q", s))
	}
	return b
}

func mustU64(s string) uint64 {
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		panic(err)
	}
	return v
}

func scalar(t, v string) *v1common.AnyValue {
	switch t {
	case "str":
		return &v1common.AnyValue{Value: &v1common.AnyValue_StringValue{StringValue: v}}
	case "int":
		i, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			panic(err)
		}
		return &v1common.AnyValue{Value: &v1common.AnyValue_IntValue{IntValue: i}}
	case "float":
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			panic(err)
		}
		return &v1common.AnyValue{Value: &v1common.AnyValue_DoubleValue{DoubleValue: f}}
	case "bool":
		return &v1common.AnyValue{Value: &v1common.AnyValue_BoolValue{BoolValue: v == "true"}}
	}
	panic("bad scalar type " + t)
}

func attrs(in []Attr) []*v1common.KeyValue {
	out := make([]*v1common.KeyValue, 0, len(in))
	for _, a := range in {
		var v *v1common.AnyValue
		if strings.HasSuffix(a.Type, "_array") {
			et := strings.TrimSuffix(a.Type, "_array")
			arr := &v1common.ArrayValue{}
			for _, e := range a.Array {
				arr.Values = append(arr.Values, scalar(et, e))
			}
			v = &v1common.AnyValue{Value: &v1common.AnyValue_ArrayValue{ArrayValue: arr}}
		} else {
			v = scalar(a.Type, a.Value)
		}
		out = append(out, &v1common.KeyValue{Key: a.Key, Value: v})
	}
	return out
}

type traceEntry struct {
	id    []byte
	trace *tempopb.Trace
	start uint64
	end   uint64
}

func buildTraces(ds *Dataset) []traceEntry {
	type rsKey struct {
		trace    string
		res, scp int
	}
	byTrace := map[string]*traceEntry{}
	rsIndex := map[rsKey]*v1trace.ScopeSpans{}
	for i := range ds.Spans {
		s := &ds.Spans[i]
		te := byTrace[s.TraceID]
		if te == nil {
			te = &traceEntry{id: mustHex(s.TraceID, 16), trace: &tempopb.Trace{}, start: ^uint64(0)}
			byTrace[s.TraceID] = te
		}
		k := rsKey{s.TraceID, s.Resource, s.Scope}
		ss := rsIndex[k]
		if ss == nil {
			sc := ds.Scopes[s.Scope]
			ss = &v1trace.ScopeSpans{Scope: &v1common.InstrumentationScope{Name: sc.Name, Version: sc.Version, Attributes: attrs(sc.Attrs)}}
			rs := &v1trace.ResourceSpans{
				Resource:   &v1resource.Resource{Attributes: attrs(ds.Resources[s.Resource])},
				ScopeSpans: []*v1trace.ScopeSpans{ss},
			}
			te.trace.ResourceSpans = append(te.trace.ResourceSpans, rs)
			rsIndex[k] = ss
		}
		sp := &v1trace.Span{
			TraceId:           te.id,
			SpanId:            mustHex(s.SpanID, 8),
			ParentSpanId:      mustHex(s.ParentSpanID, 8),
			Name:              s.Name,
			Kind:              v1trace.Span_SpanKind(s.Kind),
			StartTimeUnixNano: mustU64(s.Start),
			EndTimeUnixNano:   mustU64(s.End),
			Attributes:        attrs(s.Attrs),
			Status:            &v1trace.Status{Code: v1trace.Status_StatusCode(s.StatusCode), Message: s.StatusMessage},
		}
		for _, e := range s.Events {
			sp.Events = append(sp.Events, &v1trace.Span_Event{TimeUnixNano: mustU64(e.Time), Name: e.Name, Attributes: attrs(e.Attrs)})
		}
		for _, l := range s.Links {
			sp.Links = append(sp.Links, &v1trace.Span_Link{TraceId: mustHex(l.TraceID, 16), SpanId: mustHex(l.SpanID, 8), TraceState: l.TraceState, Attributes: attrs(l.Attrs)})
		}
		ss.Spans = append(ss.Spans, sp)
		if sp.StartTimeUnixNano < te.start {
			te.start = sp.StartTimeUnixNano
		}
		if sp.EndTimeUnixNano > te.end {
			te.end = sp.EndTimeUnixNano
		}
	}
	out := make([]traceEntry, 0, len(byTrace))
	for _, te := range byTrace {
		out = append(out, *te)
	}
	sort.Slice(out, func(i, j int) bool { return bytes.Compare(out[i].id, out[j].id) < 0 })
	return out
}

type sliceIter struct {
	traces []traceEntry
	i      int
}

func (it *sliceIter) Next(context.Context) (common.ID, *tempopb.Trace, error) {
	if it.i >= len(it.traces) {
		return nil, nil, nil
	}
	t := it.traces[it.i]
	it.i++
	return t.id, t.trace, nil
}

func (it *sliceIter) Close() {}

// ---- block ----

type block struct {
	fetcher traceql.SpansetFetcher
}

func writeBlock(ctx context.Context, dir string, ds *Dataset) (*block, error) {
	traces := buildTraces(ds)
	rr, ww, _, err := local.New(&local.Config{Path: dir})
	if err != nil {
		return nil, err
	}
	r := backend.NewReader(rr)
	w := backend.NewWriter(ww)
	meta := backend.NewBlockMeta("viz-diff", uuid.New(), vparquet5.VersionString)
	minT, maxT := ^uint64(0), uint64(0)
	for _, t := range traces {
		if t.start < minT {
			minT = t.start
		}
		if t.end > maxT {
			maxT = t.end
		}
	}
	if len(traces) == 0 {
		minT, maxT = 0, 0
	}
	meta.StartTime = time.Unix(0, int64(minT))
	meta.EndTime = time.Unix(0, int64(maxT))
	meta.TotalObjects = int64(len(traces))
	cfg := &common.BlockConfig{
		BloomFP:             0.01,
		BloomShardSizeBytes: 100 * 1024,
		Version:             vparquet5.VersionString,
		RowGroupSizeBytes:   100 * 1024 * 1024,
	}
	outMeta, err := vparquet5.CreateBlock(ctx, cfg, meta, &sliceIter{traces: traces}, r, w)
	if err != nil {
		return nil, fmt.Errorf("create block: %w", err)
	}
	blk, err := encoding.OpenBlock(outMeta, r)
	if err != nil {
		return nil, fmt.Errorf("open block: %w", err)
	}
	opts := common.DefaultSearchOptions()
	f := traceql.NewSpansetFetcherWrapperBoth(
		func(ctx context.Context, req traceql.FetchSpansRequest) (traceql.FetchSpansResponse, error) {
			return blk.Fetch(ctx, req, opts)
		},
		func(ctx context.Context, req traceql.FetchSpansRequest) (traceql.FetchSpansOnlyResponse, error) {
			return blk.FetchSpans(ctx, req, opts)
		},
	)
	return &block{fetcher: f}, nil
}

// ---- evaluation ----

var marshaler = jsonpb.Marshaler{}

func runCase(ctx context.Context, b *block, c *Case) Output {
	out := Output{ID: c.ID}
	var msg interface {
		Reset()
		String() string
		ProtoMessage()
	}
	var err error
	switch c.Kind {
	case "search":
		var resp *tempopb.SearchResponse
		resp, err = traceql.NewEngine().ExecuteSearch(ctx, &tempopb.SearchRequest{
			Query: c.Query, Limit: c.Limit, SpansPerSpanSet: c.Spss, Start: uint32(c.Start), End: uint32(c.End),
		}, b.fetcher)
		if resp != nil {
			resp.Metrics = nil // read statistics differ by design; not compared
		}
		msg = resp
	case "range", "instant":
		msg, err = metrics(ctx, b, c)
	default:
		err = fmt.Errorf("unknown kind %q", c.Kind)
	}
	if err != nil {
		out.Error = err.Error()
	} else {
		var buf bytes.Buffer
		if e := marshaler.Marshal(&buf, msg.(interface {
			Reset()
			String() string
			ProtoMessage()
		})); e != nil {
			out.Error = "marshal: " + e.Error()
		} else {
			out.Tempo = buf.Bytes()
		}
	}
	if len(c.Viz) > 0 && !bytes.HasPrefix(c.Viz, []byte(`{"error"`)) {
		var target interface {
			Reset()
			String() string
			ProtoMessage()
		}
		if c.Kind == "search" {
			target = &tempopb.SearchResponse{}
		} else {
			target = &tempopb.QueryRangeResponse{}
		}
		u := jsonpb.Unmarshaler{AllowUnknownFields: false}
		if e := u.Unmarshal(bytes.NewReader(c.Viz), target); e != nil {
			out.VizDecode = e.Error()
		}
	}
	return out
}

func metrics(ctx context.Context, b *block, c *Case) (*tempopb.QueryRangeResponse, error) {
	req := &tempopb.QueryRangeRequest{Query: c.Query, Start: c.Start, End: c.End, Step: c.Step}
	if c.Kind == "instant" {
		req.XInstant = &tempopb.QueryRangeRequest_Instant{Instant: true}
	}
	e := traceql.NewEngine()
	ev, err := e.CompileMetricsQueryRange(req)
	if err != nil {
		return nil, err
	}
	if err := ev.Do(ctx, b.fetcher, req.Start, req.End, 0); err != nil {
		return nil, err
	}
	raw := ev.Results().ToProto(req)
	fe, err := e.CompileMetricsQueryRangeNonRaw(req, traceql.AggregateModeFinal)
	if err != nil {
		return nil, err
	}
	fe.ObserveSeries(raw)
	return &tempopb.QueryRangeResponse{Series: fe.Results().ToProto(req)}, nil
}

func probe() {
	type r struct{ start, end, step uint64 }
	for _, x := range []r{
		{1_000_000_000_000, 1_000_000_600_000_000_000 / 1_000_000, 0},
		{1_700_000_000_123_000_000, 1_700_000_600_456_000_000, 60_000_000_000},
		{1_700_000_000_000_000_000, 1_700_000_600_000_000_000, 60_000_000_000},
		{1_700_000_007_000_000_000, 1_700_000_067_000_000_000, 15_000_000_000},
		{1_699_999_980_000_000_000, 1_700_000_040_000_000_000, 60_000_000_000},
		{1_700_000_000_000_000_000, 1_700_000_020_000_000_000, 1_000_000_000},
		{1_700_000_000_500_000_000, 1_700_000_020_000_000_001, 1_000_000_000},
		{1_700_000_000_000_000_000, 1_700_000_000_000_000_000, 1_000_000_000},
		{1_700_000_000_000_000_000, 1_700_000_100_000_000_000, 7_000_000_000},
	} {
		req := &tempopb.QueryRangeRequest{Start: x.start, End: x.end, Step: x.step}
		before := *req
		traceql.AlignRequest(req)
		fmt.Printf("AlignRequest start=%d end=%d step=%d -> start=%d end=%d step=%d\n", before.Start, before.End, before.Step, req.Start, req.End, req.Step)
	}
	for _, d := range []time.Duration{time.Second, 10 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 15 * time.Minute, 30 * time.Minute, time.Hour, 2 * time.Hour, 3 * time.Hour, 6 * time.Hour, 12 * time.Hour, 24 * time.Hour, 48 * time.Hour, 7 * 24 * time.Hour} {
		fmt.Printf("DefaultQueryRangeStep(%v) = %v\n", d, time.Duration(traceql.DefaultQueryRangeStep(0, uint64(d))))
	}
}

func main() {
	casesPath := flag.String("cases", "", "cases file written by the viz exporter")
	outPath := flag.String("out", "", "where to write Tempo's answers")
	doProbe := flag.Bool("probe", false, "print request alignment and default steps")
	flag.Parse()
	if *doProbe {
		probe()
		return
	}
	raw, err := os.ReadFile(*casesPath)
	if err != nil {
		panic(err)
	}
	var in Input
	if err := json.Unmarshal(raw, &in); err != nil {
		panic(err)
	}
	ctx := context.Background()
	work, err := os.MkdirTemp("", "godiff-blocks-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(work)
	blocks := make([]*block, len(in.Datasets))
	for i := range in.Datasets {
		b, err := writeBlock(ctx, filepath.Join(work, strconv.Itoa(i)), &in.Datasets[i])
		if err != nil {
			panic(fmt.Sprintf("dataset %d: %v", i, err))
		}
		blocks[i] = b
	}
	outs := make([]Output, 0, len(in.Cases))
	for i := range in.Cases {
		c := &in.Cases[i]
		func() {
			defer func() {
				if r := recover(); r != nil {
					outs = append(outs, Output{ID: c.ID, Error: fmt.Sprintf("PANIC: %v", r)})
				}
			}()
			outs = append(outs, runCase(ctx, blocks[c.Dataset], c))
		}()
	}
	enc, err := json.Marshal(outs)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(*outPath, enc, 0o644); err != nil {
		panic(err)
	}
	fmt.Fprintf(os.Stderr, "godiff: %d datasets, %d cases\n", len(in.Datasets), len(in.Cases))
}
