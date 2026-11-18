package vizrulercheck

// Independent readers for what the ruler writes in Prometheus' formats (AGENTS.md,
// "Independent readers"). Nothing here was written against viz's code: the expectations
// come from Prometheus itself.
//
//   - /api/v1/rules and /api/v1/alerts: the field names, which ones are optional
//     (`omitempty`) and their Go types are read by machine from the source of
//     prometheus/web/api/v1/api.go in the module cache (the server's own structs), and
//     every captured response is checked against them. The responses are then decoded with
//     client_golang's api/prometheus/v1 (the official client, whose RuleGroup decoder
//     switches on "type"), and numbers and times are re-printed the way the Go server
//     prints them and compared byte for byte.
//   - Rule files: the YAML viz exports is parsed with prometheus/model/rulefmt.Parse, the
//     loader Prometheus uses, with unknown fields refused. The rules it reads must be the
//     rules rulefmt reads from the file viz imported.
//
// Input: VIZ_CAPTURE, the directory test/independent.test.ts writes (see README).

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
	"github.com/prometheus/prometheus/model/rulefmt"
)

func captureDir(t *testing.T) string {
	dir := os.Getenv("VIZ_CAPTURE")
	if dir == "" {
		t.Skip("VIZ_CAPTURE not set; run `npm run independent` in ruler/")
	}
	return dir
}

// ───────────────────────────── the server's structs, from its source ─────────────────────────────

type field struct {
	name      string
	omitempty bool
	goType    string
}

// upstreamStructs parses web/api/v1/api.go of the prometheus module this test builds
// against and returns, per struct, its JSON fields.
func upstreamStructs(t *testing.T, names ...string) map[string][]field {
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/prometheus/prometheus").Output()
	if err != nil {
		t.Fatalf("locating the prometheus module: %v", err)
	}
	src := filepath.Join(strings.TrimSpace(string(out)), "web", "api", "v1", "api.go")
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, src, nil, 0)
	if err != nil {
		t.Fatalf("parsing %s: %v", src, err)
	}
	want := map[string]bool{}
	for _, n := range names {
		want[n] = true
	}
	structs := map[string][]field{}
	ast.Inspect(file, func(n ast.Node) bool {
		ts, ok := n.(*ast.TypeSpec)
		if !ok || !want[ts.Name.Name] {
			return true
		}
		st, ok := ts.Type.(*ast.StructType)
		if !ok {
			return true
		}
		var fs []field
		for _, f := range st.Fields.List {
			if f.Tag == nil || len(f.Names) == 0 {
				continue
			}
			tag := reflect.StructTag(strings.Trim(f.Tag.Value, "`")).Get("json")
			if tag == "" || tag == "-" {
				continue
			}
			parts := strings.Split(tag, ",")
			fs = append(fs, field{name: parts[0], omitempty: len(parts) > 1 && parts[1] == "omitempty", goType: exprString(f.Type)})
		}
		structs[ts.Name.Name] = fs
		return true
	})
	for _, n := range names {
		if _, ok := structs[n]; !ok {
			t.Fatalf("struct %s not found in %s", n, src)
		}
	}
	t.Logf("read %d structs from %s", len(structs), src)
	return structs
}

func exprString(e ast.Expr) string {
	switch v := e.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.StarExpr:
		return "*" + exprString(v.X)
	case *ast.ArrayType:
		return "[]" + exprString(v.Elt)
	case *ast.SelectorExpr:
		return exprString(v.X) + "." + v.Sel.Name
	case *ast.MapType:
		return "map[" + exprString(v.Key) + "]" + exprString(v.Value)
	case *ast.InterfaceType:
		return "any"
	}
	return fmt.Sprintf("%T", e)
}

// ───────────────────────────── shape checking ─────────────────────────────

type checker struct {
	t       *testing.T
	structs map[string][]field
	file    string
}

func (c *checker) fail(path, format string, args ...any) {
	c.t.Errorf("%s: %s: %s", c.file, path, fmt.Sprintf(format, args...))
}

// object checks that `v` has exactly the fields of struct `name`: every field without
// omitempty, any of the omitempty ones, nothing else, each of the Go type's JSON kind.
func (c *checker) object(path string, v any, name string) map[string]any {
	obj, ok := v.(map[string]any)
	if !ok {
		c.fail(path, "want an object (%s), got %T", name, v)
		return nil
	}
	known := map[string]field{}
	for _, f := range c.structs[name] {
		known[f.name] = f
		if _, present := obj[f.name]; !present && !f.omitempty {
			c.fail(path, "%s.%s is required (no omitempty upstream) and missing", name, f.name)
		}
	}
	for k, val := range obj {
		f, ok := known[k]
		if !ok {
			c.fail(path, "field %q is not in upstream %s", k, name)
			continue
		}
		c.value(path+"."+k, val, f.goType)
	}
	return obj
}

func (c *checker) value(path string, v any, goType string) {
	switch goType {
	case "string", "rules.RuleHealth":
		if _, ok := v.(string); !ok {
			c.fail(path, "want a string (%s), got %T", goType, v)
		}
	case "float64":
		if _, ok := v.(float64); !ok {
			c.fail(path, "want a number, got %T", v)
		}
	case "int":
		f, ok := v.(float64)
		if !ok || f != math.Trunc(f) {
			c.fail(path, "want an integer, got %v", v)
		}
	case "time.Time", "*time.Time":
		s, ok := v.(string)
		if !ok {
			c.fail(path, "want a time string, got %T", v)
			return
		}
		var tm time.Time
		if err := json.Unmarshal([]byte(strconv.Quote(s)), &tm); err != nil {
			c.fail(path, "not a time Go reads: %v", err)
			return
		}
		// What the Go server would print for the same instant.
		want, _ := json.Marshal(tm.UTC())
		if string(want) != strconv.Quote(s) {
			c.fail(path, "Go prints this time as %s, viz printed %q", want, s)
		}
	case "labels.Labels":
		m, ok := v.(map[string]any)
		if !ok {
			c.fail(path, "want a label map, got %T", v)
			return
		}
		for k, x := range m {
			if _, ok := x.(string); !ok {
				c.fail(path+"."+k, "label value must be a string, got %T", x)
			}
		}
	case "[]*Alert":
		if v == nil {
			return // Go's nil slice
		}
		arr, ok := v.([]any)
		if !ok {
			c.fail(path, "want an array of alerts or null, got %T", v)
			return
		}
		for i, a := range arr {
			c.alert(fmt.Sprintf("%s[%d]", path, i), a)
		}
	case "[]Rule":
		arr, ok := v.([]any)
		if !ok {
			c.fail(path, "want an array of rules, got %T", v)
			return
		}
		for i, r := range arr {
			c.rule(fmt.Sprintf("%s[%d]", path, i), r)
		}
	case "[]*RuleGroup":
		arr, ok := v.([]any)
		if !ok {
			c.fail(path, "want an array of groups, got %T", v)
			return
		}
		for i, g := range arr {
			c.object(fmt.Sprintf("%s[%d]", path, i), g, "RuleGroup")
		}
	case "any", "interface{}":
	default:
		c.fail(path, "no check for Go type %s", goType)
	}
}

func (c *checker) rule(path string, v any) {
	obj, ok := v.(map[string]any)
	if !ok {
		c.fail(path, "want a rule object, got %T", v)
		return
	}
	switch obj["type"] {
	case "alerting":
		c.object(path, obj, "AlertingRule")
		if s := obj["state"]; s != "inactive" && s != "pending" && s != "firing" {
			c.fail(path, "state %v", s)
		}
	case "recording":
		c.object(path, obj, "RecordingRule")
	default:
		c.fail(path, "type must be \"alerting\" or \"recording\", got %v", obj["type"])
	}
	if h := obj["health"]; h != "ok" && h != "err" && h != "unknown" {
		c.fail(path, "health %v", h)
	}
}

func (c *checker) alert(path string, v any) {
	obj := c.object(path, v, "Alert")
	if obj == nil {
		return
	}
	if s := obj["state"]; s != "pending" && s != "firing" {
		c.fail(path, "an active alert's state is pending or firing, got %v", s)
	}
	// strconv.FormatFloat(v, 'e', -1, 64), as rulesAlertsToAPIAlerts prints it.
	if s, ok := obj["value"].(string); ok {
		f, err := strconv.ParseFloat(s, 64)
		if err != nil && s != "NaN" && s != "+Inf" && s != "-Inf" {
			c.fail(path+".value", "not a float: %q", s)
		} else if want := strconv.FormatFloat(f, 'e', -1, 64); want != s {
			c.fail(path+".value", "Go prints %q, viz printed %q", want, s)
		}
	}
}

func readJSON(t *testing.T, path string) map[string]any {
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return v
}

func TestPrometheusAPIShapes(t *testing.T) {
	dir := filepath.Join(captureDir(t), "api")
	structs := upstreamStructs(t, "response", "RuleDiscovery", "RuleGroup", "AlertingRule", "RecordingRule", "Alert", "AlertDiscovery")
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	if len(files) == 0 {
		t.Fatalf("no captured responses in %s", dir)
	}
	sort.Strings(files)
	counts := map[string]int{}
	for _, f := range files {
		c := &checker{t: t, structs: structs, file: filepath.Base(f)}
		body := readJSON(t, f)
		env := c.object("$", body, "response")
		raw, _ := json.Marshal(body["data"])
		switch {
		case strings.HasSuffix(f, ".error.json"):
			if env["status"] != "error" || env["errorType"] == nil || env["error"] == nil || env["data"] != nil {
				c.fail("$", "an error is {status: error, errorType, error}: %v", env)
			}
			counts["error"]++
		case strings.HasSuffix(f, ".rules.json"):
			if env["status"] != "success" {
				c.fail("$.status", "%v", env["status"])
			}
			data := c.object("$.data", body["data"], "RuleDiscovery")
			var rr promv1.RulesResult
			if err := json.Unmarshal(raw, &rr); err != nil {
				c.fail("$.data", "client_golang cannot decode it: %v", err)
				continue
			}
			// The client's decoder dispatched every rule by its "type" to the same kind.
			groups, _ := data["groups"].([]any)
			if len(rr.Groups) != len(groups) {
				c.fail("$.data.groups", "client read %d groups, JSON has %d", len(rr.Groups), len(groups))
			}
			for gi, g := range rr.Groups {
				rules := groups[gi].(map[string]any)["rules"].([]any)
				for ri, r := range g.Rules {
					kind := rules[ri].(map[string]any)["type"]
					switch r.(type) {
					case promv1.AlertingRule:
						counts["alerting rule"]++
						if kind != "alerting" {
							c.fail(fmt.Sprintf("$.data.groups[%d].rules[%d]", gi, ri), "client read an alerting rule, type is %v", kind)
						}
					case promv1.RecordingRule:
						counts["recording rule"]++
						if kind != "recording" {
							c.fail(fmt.Sprintf("$.data.groups[%d].rules[%d]", gi, ri), "client read a recording rule, type is %v", kind)
						}
					default:
						c.fail(fmt.Sprintf("$.data.groups[%d].rules[%d]", gi, ri), "client read %T", r)
					}
				}
			}
			counts["rules response"]++
		case strings.HasSuffix(f, ".alerts.json"):
			if env["status"] != "success" {
				c.fail("$.status", "%v", env["status"])
			}
			data := c.object("$.data", body["data"], "AlertDiscovery")
			if arr, ok := data["alerts"].([]any); ok {
				for i, a := range arr {
					c.alert(fmt.Sprintf("$.data.alerts[%d]", i), a)
					counts["alert"]++
				}
			} else {
				c.fail("$.data.alerts", "want an array")
			}
			var ar promv1.AlertsResult
			if err := json.Unmarshal(raw, &ar); err != nil {
				c.fail("$.data", "client_golang cannot decode it: %v", err)
			}
			for i, a := range ar.Alerts {
				if a.ActiveAt.IsZero() || a.Labels["alertname"] == "" || (a.State != promv1.AlertStateFiring && a.State != promv1.AlertStatePending) {
					c.fail(fmt.Sprintf("$.data.alerts[%d]", i), "client read %+v", a)
				}
			}
			counts["alerts response"]++
		default:
			t.Errorf("%s: unknown capture kind", f)
		}
	}
	t.Logf("checked %d files: %v", len(files), counts)
	for _, k := range []string{"rules response", "alerts response", "error", "alerting rule", "recording rule", "alert"} {
		if counts[k] == 0 {
			t.Errorf("the capture has no %s: the check proves nothing about it", k)
		}
	}
}

// ───────────────────────────── rule files ─────────────────────────────

type normRule struct {
	Kind, Name, Expr string
	For, Keep        model.Duration
	Labels           map[string]string
	Annotations      map[string]string
}

type normGroup struct {
	Name        string
	Interval    model.Duration
	QueryOffset model.Duration
	Limit       int
	Rules       []normRule
}

// normalize what rulefmt read into what a group means to Prometheus: group labels applied
// to each rule (a rule's own label wins), the default interval made explicit.
func normalize(gs *rulefmt.RuleGroups, defaultInterval model.Duration) []normGroup {
	var out []normGroup
	for _, g := range gs.Groups {
		ng := normGroup{Name: g.Name, Interval: g.Interval, Limit: g.Limit}
		if ng.Interval == 0 {
			ng.Interval = defaultInterval
		}
		if g.QueryOffset != nil {
			ng.QueryOffset = *g.QueryOffset
		}
		for _, r := range g.Rules {
			nr := normRule{Expr: r.Expr, For: r.For, Keep: r.KeepFiringFor, Labels: map[string]string{}, Annotations: map[string]string{}}
			if r.Alert != "" {
				nr.Kind, nr.Name = "alert", r.Alert
			} else {
				nr.Kind, nr.Name = "record", r.Record
			}
			for k, v := range g.Labels {
				nr.Labels[k] = v
			}
			for k, v := range r.Labels {
				nr.Labels[k] = v
			}
			for k, v := range r.Annotations {
				nr.Annotations[k] = v
			}
			ng.Rules = append(ng.Rules, nr)
		}
		out = append(out, ng)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func parseRuleFile(t *testing.T, path string) *rulefmt.RuleGroups {
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// ignoreUnknownFields=false: what `promtool check rules` and the Prometheus loader do.
	gs, errs := rulefmt.Parse(b, false, model.UTF8Validation)
	for _, e := range errs {
		t.Errorf("%s: Prometheus refuses it: %v", filepath.Base(path), e)
	}
	if gs == nil {
		t.FailNow()
	}
	return gs
}

func TestRuleFilesRoundTripThroughPrometheusLoader(t *testing.T) {
	dir := filepath.Join(captureDir(t), "rulefile")
	inputs, _ := filepath.Glob(filepath.Join(dir, "*.input.yaml"))
	if len(inputs) == 0 {
		t.Fatalf("no captured rule files in %s", dir)
	}
	defaultInterval := model.Duration(time.Minute)
	for _, in := range inputs {
		name := strings.TrimSuffix(filepath.Base(in), ".input.yaml")
		t.Run(name, func(t *testing.T) {
			original := normalize(parseRuleFile(t, in), defaultInterval)
			exported := normalize(parseRuleFile(t, filepath.Join(dir, name+".export.yaml")), defaultInterval)
			if !reflect.DeepEqual(original, exported) {
				a, _ := json.MarshalIndent(original, "", " ")
				b, _ := json.MarshalIndent(exported, "", " ")
				t.Errorf("Prometheus reads different rules from viz's export than from the file viz imported\nimported: %s\nexported: %s", a, b)
			}
			rules := 0
			for _, g := range original {
				rules += len(g.Rules)
			}
			t.Logf("%s: %d groups, %d rules, identical as read by rulefmt", name, len(original), rules)
			// With viz's own fields kept, the file is no longer one Prometheus loads: say so.
			if ext := filepath.Join(dir, name+".extensions.yaml"); fileExists(ext) {
				b, _ := os.ReadFile(ext)
				if _, errs := rulefmt.Parse(b, false, model.UTF8Validation); len(errs) == 0 && strings.Contains(string(b), "monitor:") {
					t.Errorf("rulefmt accepted viz extension fields; the export option is then pointless")
				}
				if _, errs := rulefmt.Parse(b, true, model.UTF8Validation); len(errs) != 0 {
					t.Errorf("with unknown fields ignored, Prometheus still refuses the extended export: %v", errs)
				}
			}
		})
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
