# Quantile probe: bucket i (1s wide) holds spans with the given durations (ns) and attribute v.
import json, subprocess, sys
import os
SCR=os.environ['VIZ_TQ_WORK']  # a scratch directory holding bin/godiff
S=1_700_000_000_000_000_000
groups=json.loads(sys.argv[1])   # list of lists of durations (ns) or of [dur, v]
queries=sys.argv[2:]
spans=[]; n=0
for i,g in enumerate(groups):
    for j,d in enumerate(g):
        v=None
        if isinstance(d,list): d,v=d
        n+=1
        tid="%032x"%n; sid="%016x"%n
        attrs=[]
        if v is not None:
            t="int" if isinstance(v,int) else "float"
            attrs=[{"key":"v","type":t,"value":repr(float(v)) if t=="float" else str(v)}]
        st=S+(i*1_000_000_000)+500_000_000+j
        spans.append({"trace_id":tid,"span_id":sid,"parent_span_id":"","name":"x","kind":2,"status_code":0,"status_message":"","start":str(st),"end":str(st+d),"resource":0,"scope":0,"attrs":attrs,"events":[],"links":[]})
ds={"resources":[[{"key":"service.name","type":"str","value":"s"}]],"scopes":[{"name":"","version":"","attrs":[]}],"spans":spans}
cases=[{"id":k,"dataset":0,"kind":"range","query":q,"start":S,"end":S+len(groups)*1_000_000_000,"step":1_000_000_000} for k,q in enumerate(queries)]
json.dump({"datasets":[ds],"cases":cases},open(SCR+'/probe/qcases.json','w'))
subprocess.run([SCR+'/bin/godiff','-cases',SCR+'/probe/qcases.json','-out',SCR+'/probe/qout.json'],check=True,stderr=subprocess.DEVNULL)
for c,o in zip(cases,json.load(open(SCR+'/probe/qout.json'))):
    print("Q:",c["query"])
    if o.get("error"): print("  ERR",o["error"]); continue
    for s in o["tempo"].get("series",[]):
        lab={kv["key"]:list(kv["value"].values())[0] for kv in s["labels"]}
        vals=[(int(x["timestampMs"])-S//1_000_000)//1000 for x in s["samples"]]
        print("  ",lab,[ (int(x["timestampMs"])-S//1_000_000)//1000 for x in s["samples"]], [x.get("value",0) for x in s["samples"]])
