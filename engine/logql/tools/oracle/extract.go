// extract: turns the test tables of Loki's own test files (fetched by fetch.sh into the
// git-ignored testdata/loki-oracle/) into behavioural expectations for viz-logql's
// conformance test: "this query is accepted / rejected" and "this pipeline stage over this
// line and these labels gives this line and these labels".
//
// It reads Go source with the standard library's go/parser only; nothing of Loki is
// compiled or linked. Only test tables are read, and only the values of their fields
// (strings, label sets, byte slices); cases whose values are not plain data are skipped
// with a reason. AST-shape expectations (the `exp` field of parser tests) are ignored.
//
// Usage: go run extract.go <dir with the fetched files> > cases.json
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Which tables to read: file, test function (or package-level variable), and the kind of
// expectation they carry.
var targets = []struct{ file, fn, kind string }{
	{"pkg_logql_syntax_parser_test.go", "ParseTestCases", "parse"},
	{"pkg_logql_syntax_parser_test.go", "TestParseSampleExpr_equalityMatcher", "parse_sample"},
	{"pkg_logql_syntax_parser_test.go", "TestParseLogSelectorExpr_equalityMatcher", "parse_log"},
	{"pkg_logql_log_parser_test.go", "Test_jsonParser_Parse", "json"},
	{"pkg_logql_log_parser_test.go", "TestJSONExpressionParser", "json_expr"},
	{"pkg_logql_log_parser_test.go", "Test_regexpParser_Parse", "regexp"},
	{"pkg_logql_log_parser_test.go", "TestLogfmtParser_parse", "logfmt"},
	{"pkg_logql_log_parser_test.go", "TestLogfmtParser_keepEmpty", "logfmt_keep_empty"},
	{"pkg_logql_log_parser_test.go", "TestLogfmtExpressionParser", "logfmt_expr"},
	{"pkg_logql_log_parser_test.go", "Test_unpackParser_Parse", "unpack"},
	{"pkg_logql_log_parser_test.go", "Test_PatternParser", "pattern"},
	{"pkg_logql_log_fmt_test.go", "Test_lineFormatter_Format", "line_format"},
	{"pkg_logql_log_fmt_test.go", "Test_labelsFormatter_Format", "label_format"},
}

type unevaluable struct{ why string }

type evaluator struct {
	fset   *token.FileSet
	locals map[string]ast.Expr
}

func (e *evaluator) fail(n ast.Node, why string) {
	panic(unevaluable{fmt.Sprintf("%s at line %d", why, e.fset.Position(n.Pos()).Line)})
}

func (e *evaluator) str(x ast.Expr) string {
	v := e.eval(x)
	s, ok := v.(string)
	if !ok {
		e.fail(x, "not a string")
	}
	return s
}

// eval turns a plain-data Go expression into a JSON-able value.
func (e *evaluator) eval(x ast.Expr) interface{} {
	switch n := x.(type) {
	case *ast.BasicLit:
		switch n.Kind {
		case token.STRING:
			s, err := strconv.Unquote(n.Value)
			if err != nil {
				e.fail(n, "bad string")
			}
			return s
		case token.INT:
			v, err := strconv.ParseInt(n.Value, 0, 64)
			if err != nil {
				e.fail(n, "bad int")
			}
			return v
		case token.FLOAT:
			v, _ := strconv.ParseFloat(n.Value, 64)
			return v
		}
	case *ast.Ident:
		switch n.Name {
		case "nil":
			return nil
		case "true":
			return true
		case "false":
			return false
		}
		if l, ok := e.locals[n.Name]; ok {
			return e.eval(l)
		}
		e.fail(n, "identifier "+n.Name)
	case *ast.BinaryExpr:
		if n.Op == token.ADD {
			return e.str(n.X) + e.str(n.Y)
		}
	case *ast.ParenExpr:
		return e.eval(n.X)
	case *ast.CompositeLit:
		switch t := n.Type.(type) {
		case *ast.ArrayType:
			if id, ok := t.Elt.(*ast.Ident); ok && id.Name == "byte" && len(n.Elts) == 0 {
				return ""
			}
			var out []interface{}
			for _, el := range n.Elts {
				out = append(out, e.eval(el))
			}
			return out
		case *ast.MapType:
			m := map[string]interface{}{}
			for _, el := range n.Elts {
				kv := el.(*ast.KeyValueExpr)
				m[e.str(kv.Key)] = e.eval(kv.Value)
			}
			return m
		case *ast.SelectorExpr:
			if t.Sel.Name == "Labels" && len(n.Elts) == 0 {
				return map[string]interface{}{}
			}
		}
	case *ast.CallExpr:
		name := callName(n.Fun)
		args := func() []interface{} {
			var out []interface{}
			for _, a := range n.Args {
				out = append(out, e.eval(a))
			}
			return out
		}
		switch name {
		case "[]byte", "string":
			if len(n.Args) == 1 {
				return e.str(n.Args[0])
			}
		case "labels.FromStrings":
			a := args()
			m := map[string]interface{}{}
			for i := 0; i+1 < len(a); i += 2 {
				m[a[i].(string)] = a[i+1]
			}
			return m
		case "labels.EmptyLabels":
			return map[string]interface{}{}
		case "newMustLineFormatter":
			return map[string]interface{}{"line_format": e.str(n.Args[0])}
		case "mustNewLabelsFormatter":
			return map[string]interface{}{"label_format": e.eval(n.Args[0])}
		case "NewRenameLabelFmt":
			return map[string]interface{}{"rename": []interface{}{e.str(n.Args[0]), e.str(n.Args[1])}}
		case "NewTemplateLabelFmt":
			return map[string]interface{}{"template": []interface{}{e.str(n.Args[0]), e.str(n.Args[1])}}
		case "NewLabelExtractionExpr":
			return []interface{}{e.str(n.Args[0]), e.str(n.Args[1])}
		case "mustStage":
			return e.eval(n.Args[0])
		case "NewRegexpParser":
			return map[string]interface{}{"regexp": e.str(n.Args[0])}
		}
		e.fail(n, "call "+name)
	}
	e.fail(x, fmt.Sprintf("expression %T", x))
	return nil
}

func callName(f ast.Expr) string {
	switch t := f.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		if id, ok := t.X.(*ast.Ident); ok {
			return id.Name + "." + t.Sel.Name
		}
	case *ast.ArrayType:
		if id, ok := t.Elt.(*ast.Ident); ok {
			return "[]" + id.Name
		}
	}
	return fmt.Sprintf("%T", f)
}

type out struct {
	Kind    string                   `json:"kind"`
	Table   string                   `json:"table"`
	Cases   []map[string]interface{} `json:"cases"`
	Skipped []map[string]string      `json:"skipped"`
}

func fieldNames(st *ast.StructType) []string {
	var names []string
	for _, f := range st.Fields.List {
		for _, n := range f.Names {
			names = append(names, n.Name)
		}
	}
	return names
}

func extract(fset *token.FileSet, file *ast.File, fn, kind string) out {
	o := out{Kind: kind, Table: fn}
	var table *ast.CompositeLit
	locals := map[string]ast.Expr{}
	ast.Inspect(file, func(n ast.Node) bool {
		switch d := n.(type) {
		case *ast.FuncDecl:
			if d.Name.Name != fn {
				return true
			}
			ast.Inspect(d, func(m ast.Node) bool {
				if as, ok := m.(*ast.AssignStmt); ok && len(as.Lhs) == 1 && len(as.Rhs) == 1 {
					if id, ok := as.Lhs[0].(*ast.Ident); ok {
						locals[id.Name] = as.Rhs[0]
					}
				}
				if cl, ok := m.(*ast.CompositeLit); ok && table == nil {
					if at, ok := cl.Type.(*ast.ArrayType); ok {
						if _, ok := at.Elt.(*ast.StructType); ok {
							table = cl
						}
					}
				}
				return true
			})
			return false
		case *ast.ValueSpec:
			for i, nm := range d.Names {
				if nm.Name == fn && i < len(d.Values) {
					if cl, ok := d.Values[i].(*ast.CompositeLit); ok {
						table = cl
					}
				}
			}
		}
		return true
	})
	if table == nil {
		o.Skipped = append(o.Skipped, map[string]string{"case": "*", "why": "table not found"})
		return o
	}
	names := fieldNames(table.Type.(*ast.ArrayType).Elt.(*ast.StructType))
	ev := &evaluator{fset: fset, locals: locals}
	for _, el := range table.Elts {
		cl, ok := el.(*ast.CompositeLit)
		if !ok {
			continue
		}
		line := fset.Position(cl.Pos()).Line
		c := map[string]interface{}{"src_line": line}
		func() {
			defer func() {
				if r := recover(); r != nil {
					u, ok := r.(unevaluable)
					if !ok {
						panic(r)
					}
					o.Skipped = append(o.Skipped, map[string]string{"case": strconv.Itoa(line), "why": u.why})
					c = nil
				}
			}()
			for i, f := range cl.Elts {
				var key string
				var val ast.Expr
				if kv, ok := f.(*ast.KeyValueExpr); ok {
					key = kv.Key.(*ast.Ident).Name
					val = kv.Value
				} else if i < len(names) {
					key = names[i]
					val = f
				}
				switch key {
				case "exp", "wantJSONPath":
					// AST shapes and internal paths are not used.
					continue
				case "err":
					if id, ok := val.(*ast.Ident); ok && id.Name == "nil" {
						c["err"] = false
					} else {
						c["err"] = true
					}
					continue
				case "hints":
					// NoParserHints() (or nil) means "extract everything", the query semantics;
					// any other hint tests an internal optimisation.
					if id, ok := val.(*ast.Ident); ok && id.Name == "nil" {
						continue
					}
					if call, ok := val.(*ast.CallExpr); ok && callName(call.Fun) == "NoParserHints" {
						continue
					}
					ev.fail(val, "parser hints (internal optimisation)")
					continue
				}
				c[key] = ev.eval(val)
			}
		}()
		if c != nil {
			o.Cases = append(o.Cases, c)
		}
	}
	return o
}

func main() {
	dir := os.Args[1]
	fset := token.NewFileSet()
	var outs []out
	for _, t := range targets {
		f, err := parser.ParseFile(fset, filepath.Join(dir, t.file), nil, 0)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		outs = append(outs, extract(fset, f, t.fn, t.kind))
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	if err := enc.Encode(outs); err != nil {
		panic(err)
	}
	for _, o := range outs {
		fmt.Fprintf(os.Stderr, "%s: %d cases, %d skipped\n", o.Table, len(o.Cases), len(o.Skipped))
	}
	_ = strings.TrimSpace
}
