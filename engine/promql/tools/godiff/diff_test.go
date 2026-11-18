package vizdiff

// Differential test: evaluates the same data and queries with the Prometheus
// reference engine and compares with the results viz-promql exported.
// The exported JSON is decoded with prometheus/common/model, an independent
// reader of the HTTP API shape.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/common/model"
	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql"
	"github.com/prometheus/prometheus/promql/parser"
	"github.com/prometheus/prometheus/util/teststorage"
)

type series struct {
	Labels map[string]string `json:"labels"`
	Ts     []int64           `json:"ts"`
	Bits   []string          `json:"bits"`
}

type query struct {
	Q       string          `json:"q"`
	Start   int64           `json:"start"`
	End     int64           `json:"end"`
	Step    int64           `json:"step"`
	Instant bool            `json:"instant"`
	Ours    json.RawMessage `json:"ours"`
	OursErr string          `json:"ours_err"`
}

type tcase struct {
	Delayed bool     `json:"delayed"`
	Series  []series `json:"series"`
	Queries []query  `json:"queries"`
}

type apiData struct {
	ResultType string          `json:"resultType"`
	Result     json.RawMessage `json:"result"`
}

func eq(a, b float64) bool {
	if math.IsNaN(a) && math.IsNaN(b) {
		return true
	}
	if a == b {
		return true
	}
	d := math.Abs(a - b)
	return d <= 1e-9*math.Max(math.Abs(a), math.Abs(b)) || d < 1e-300
}

// canonical form: metric string -> "t:v" list (values kept as floats for tolerant compare)
type pt struct {
	t int64
	v float64
}

func fromOurs(t *testing.T, d apiData) (map[string][]pt, error) {
	out := map[string][]pt{}
	switch d.ResultType {
	case "matrix":
		var m model.Matrix
		if err := json.Unmarshal(d.Result, &m); err != nil {
			return nil, err
		}
		for _, s := range m {
			k := s.Metric.String()
			if _, dup := out[k]; dup {
				return nil, fmt.Errorf("duplicate series %s", k)
			}
			for _, p := range s.Values {
				out[k] = append(out[k], pt{int64(p.Timestamp), float64(p.Value)})
			}
		}
	case "vector":
		var v model.Vector
		if err := json.Unmarshal(d.Result, &v); err != nil {
			return nil, err
		}
		for _, s := range v {
			k := s.Metric.String()
			if _, dup := out[k]; dup {
				return nil, fmt.Errorf("duplicate series %s", k)
			}
			out[k] = append(out[k], pt{int64(s.Timestamp), float64(s.Value)})
		}
	case "scalar":
		var s model.Scalar
		if err := json.Unmarshal(d.Result, &s); err != nil {
			return nil, err
		}
		out["scalar"] = []pt{{int64(s.Timestamp), float64(s.Value)}}
	default:
		return nil, fmt.Errorf("unexpected resultType %q", d.ResultType)
	}
	return out, nil
}

func metricKey(l labels.Labels) string {
	m := model.Metric{}
	l.Range(func(x labels.Label) { m[model.LabelName(x.Name)] = model.LabelValue(x.Value) })
	return m.String()
}

func fromGo(v parser.Value) map[string][]pt {
	out := map[string][]pt{}
	switch x := v.(type) {
	case promql.Matrix:
		for _, s := range x {
			k := metricKey(s.Metric)
			for _, p := range s.Floats {
				out[k] = append(out[k], pt{p.T, p.F})
			}
		}
	case promql.Vector:
		for _, s := range x {
			out[metricKey(s.Metric)] = append(out[metricKey(s.Metric)], pt{s.T, s.F})
		}
	case promql.Scalar:
		out["scalar"] = []pt{{x.T, x.V}}
	}
	return out
}

// valuesOnly reduces a result to the sorted values per timestamp, for
// topk/bottomk where ties may be broken differently.
func valuesOnly(m map[string][]pt) map[int64][]float64 {
	out := map[int64][]float64{}
	for _, pts := range m {
		for _, p := range pts {
			out[p.t] = append(out[p.t], p.v)
		}
	}
	for _, vs := range out {
		sort.Slice(vs, func(i, j int) bool {
			if math.IsNaN(vs[i]) {
				return !math.IsNaN(vs[j])
			}
			return vs[i] < vs[j]
		})
	}
	return out
}

func compare(q string, ours, theirs map[string][]pt) string {
	if strings.Contains(q, "topk") || strings.Contains(q, "bottomk") {
		a, b := valuesOnly(ours), valuesOnly(theirs)
		if len(a) != len(b) {
			return fmt.Sprintf("timestamps differ: ours %d theirs %d", len(a), len(b))
		}
		for t, av := range a {
			bv := b[t]
			if len(av) != len(bv) {
				return fmt.Sprintf("t=%d: ours %v theirs %v", t, av, bv)
			}
			for i := range av {
				if !eq(av[i], bv[i]) {
					return fmt.Sprintf("t=%d: ours %v theirs %v", t, av, bv)
				}
			}
		}
		return ""
	}
	if len(ours) != len(theirs) {
		var ok, tk []string
		for k := range ours {
			ok = append(ok, k)
		}
		for k := range theirs {
			tk = append(tk, k)
		}
		sort.Strings(ok)
		sort.Strings(tk)
		return fmt.Sprintf("series differ: ours %v theirs %v", ok, tk)
	}
	for k, a := range ours {
		b, found := theirs[k]
		if !found {
			return fmt.Sprintf("series %s only in ours", k)
		}
		if len(a) != len(b) {
			return fmt.Sprintf("series %s: ours %d points, theirs %d", k, len(a), len(b))
		}
		for i := range a {
			if a[i].t != b[i].t || !eq(a[i].v, b[i].v) {
				return fmt.Sprintf("series %s point %d: ours (%d, %v) theirs (%d, %v)", k, i, a[i].t, a[i].v, b[i].t, b[i].v)
			}
		}
	}
	return ""
}

func TestDiff(t *testing.T) {
	path := os.Getenv("VIZ_CASES")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cases []tcase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	parser.EnableExperimentalFunctions = true
	ctx := context.Background()
	total, agree, bothErr, mismatches := 0, 0, 0, 0
	byQuery := map[string]int{}
	for ci, c := range cases {
		st := teststorage.New(t)
		app := st.Appender(ctx)
		for _, s := range c.Series {
			lbls := labels.FromMap(s.Labels)
			for i, ts := range s.Ts {
				bits, _ := strconv.ParseUint(s.Bits[i], 16, 64)
				if _, err := app.Append(0, lbls, ts, math.Float64frombits(bits)); err != nil {
					t.Fatalf("append: %v", err)
				}
			}
		}
		if err := app.Commit(); err != nil {
			t.Fatal(err)
		}
		eng := promql.NewEngine(promql.EngineOpts{
			MaxSamples:               50000000,
			Timeout:                  100 * time.Second,
			LookbackDelta:            5 * time.Minute,
			NoStepSubqueryIntervalFn: func(int64) int64 { return 60000 },
			EnableAtModifier:         true,
			EnableNegativeOffset:     true,
			EnableDelayedNameRemoval: c.Delayed,
		})
		for _, q := range c.Queries {
			total++
			var qry promql.Query
			var qerr error
			if q.Instant {
				qry, qerr = eng.NewInstantQuery(ctx, st, nil, q.Q, time.UnixMilli(q.Start))
			} else {
				qry, qerr = eng.NewRangeQuery(ctx, st, nil, q.Q, time.UnixMilli(q.Start), time.UnixMilli(q.End), time.Duration(q.Step)*time.Millisecond)
			}
			var res *promql.Result
			if qerr == nil {
				res = qry.Exec(ctx)
				qerr = res.Err
			}
			report := func(msg string) {
				mismatches++
				byQuery[q.Q]++
				if mismatches <= 40 {
					t.Errorf("case %d delayed=%v instant=%v [%d,%d,%d] %s\n    %s", ci, c.Delayed, q.Instant, q.Start, q.End, q.Step, q.Q, msg)
				}
			}
			switch {
			case qerr != nil && q.OursErr != "":
				bothErr++
				agree++
			case qerr != nil:
				report("prometheus error: " + qerr.Error() + " but ours succeeded")
			case q.OursErr != "":
				report("ours error: " + q.OursErr + " but prometheus succeeded")
			default:
				var d apiData
				if err := json.Unmarshal(q.Ours, &d); err != nil {
					report("cannot decode ours: " + err.Error())
					break
				}
				ours, err := fromOurs(t, d)
				if err != nil {
					report("prometheus/common/model cannot read ours: " + err.Error())
					break
				}
				if msg := compare(q.Q, ours, fromGo(res.Value)); msg != "" {
					report(msg)
				} else {
					agree++
				}
			}
			if qry != nil {
				qry.Close()
			}
		}
		st.Close()
	}
	t.Logf("queries=%d agree=%d (of which both error=%d) mismatches=%d", total, agree, bothErr, mismatches)
	type kv struct {
		k string
		v int
	}
	var kvs []kv
	for k, v := range byQuery {
		kvs = append(kvs, kv{k, v})
	}
	sort.Slice(kvs, func(i, j int) bool { return kvs[i].v > kvs[j].v })
	for _, x := range kvs {
		t.Logf("  %5d  %s", x.v, x.k)
	}
}
