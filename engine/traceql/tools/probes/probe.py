# Black-box probes of Tempo used to establish the behaviours listed in README.md.
# They run tools/godiff on small hand-made data sets; VIZ_TQ_WORK must hold bin/godiff
# and the subdirectories probe/ and work/.
# Probe Tempo (black box) with a small hand-made dataset. Usage: probe.py queries.txt [search|range]
import json, subprocess, sys, os
import os
SCR=os.environ['VIZ_TQ_WORK']  # a scratch directory holding bin/godiff
S=1_700_000_000_000_000_000
def a(k,t,v): 
    if t.endswith('_array'): return {"key":k,"type":t,"array":[str(x) for x in v]}
    return {"key":k,"type":t,"value":str(v).lower() if t=='bool' else str(v)}  # floats may be "nan", "inf"
resources=[[a("service.name","str","frontend"),a("env","str","prod")],
           [a("service.name","str","backend"),a("env","str","prod"),a("rint","int",7)],
           [a("service.name","str","db")],
           [a("host","str","h1")]]  # no service.name
scopes=[{"name":"lib","version":"1.0","attrs":[a("lang","str","go")]},{"name":"","version":"","attrs":[]}]
def sp(tid,sid,pid,name,res,kind=2,st=0,msg="",start=0,dur=100,attrs=[],events=[],links=[],scope=0):
    return {"trace_id":tid,"span_id":sid,"parent_span_id":pid,"name":name,"kind":kind,"status_code":st,"status_message":msg,
            "start":str(S+start*1_000_000),"end":str(S+(start+dur)*1_000_000),"resource":res,"scope":scope,"attrs":attrs,"events":events,"links":links}
TA="0a"*16; TB="0b"*16; TC="000000000000000000000000000000cc"; TD="0000000000000000000000000000dddd"; TE="0e"*16
spans=[
 sp(TA,"a1"*8,"","GET /",0,kind=2,st=0,start=0,dur=1000,attrs=[a("http.status_code","int",200),a("foo","str","bar"),a("b","bool",True),a("f","float",1.5),a("arr","str_array",["x","y"]),a("n","int",3)]),
 sp(TA,"a2"*8,"a1"*8,"db",1,kind=3,st=2,msg="boom",start=10,dur=500,attrs=[a("foo","str","baz"),a("http.status_code","int",500),a("n","int",5),a("f","float",2.5)],
    events=[{"time":str(S+15_000_000),"name":"exception","attrs":[a("exception.message","str","boom"),a("ev","int",1)]},{"time":str(S+20_000_000),"name":"log","attrs":[a("ev","int",2)]}]),
 sp(TA,"a3"*8,"a2"*8,"query",2,kind=1,st=1,start=20,dur=200,attrs=[a("n","int",7),a("r","float","nan"),a("ea","str_array",[])],links=[{"trace_id":TB,"span_id":"b1"*8,"trace_state":"","attrs":[a("lk","str","v")]}]),
 sp(TA,"a4"*8,"a1"*8,"cache",1,kind=3,st=0,start=600,dur=50,attrs=[a("foo","str","bar"),a("n","float",4.5),a("ia","int_array",[500,3])]),
 sp(TB,"b1"*8,"","POST /",0,kind=2,st=2,start=5000,dur=300,attrs=[a("http.status_code","str","200")],scope=1),
 sp(TB,"b2"*8,"b1"*8,"db",1,kind=3,st=0,start=5100,dur=100,attrs=[a("foo","str","bar")],scope=1),
 sp(TC,"c1"*8,"ff"*8,"orphan",3,kind=0,st=0,start=9000,dur=10,attrs=[]),
 sp(TD,"00000000000000d1","","droot",0,kind=2,start=12000,dur=100,attrs=[a("n","int",1)]),
 sp(TD,"00000000000000d2","00000000000000d1","dchild",1,kind=3,start=12010,dur=10,attrs=[a("n","int",2)]),
 sp(TD,"00000000000000d3","eeeeeeeeeeeeeeee","dorphan",1,kind=3,start=12020,dur=10,attrs=[a("n","int",3)]),
 sp(TE,"e1"*8,"","eroot1",0,kind=2,start=15000,dur=1500,attrs=[a("f","float",0.5)]),
 sp(TE,"e2"*8,"","eroot2",0,kind=2,start=15000,dur=1,attrs=[a("f","float",1.0)]),
 sp(TE,"e3"*8,"e1"*8,"ec1",1,kind=2,start=15100,dur=1,attrs=[]),
 sp(TE,"e4"*8,"e2"*8,"ec2",1,kind=2,start=15200,dur=1,attrs=[]),
 sp(TD,"00000000000000d4","00000000000000d3","dorphanchild",2,kind=1,start=12030,dur=10,attrs=[a("n","int",4)]),
]
ds={"resources":resources,"scopes":scopes,"spans":spans}
kind=sys.argv[2] if len(sys.argv)>2 else 'search'
qs=[l.rstrip('\n') for l in open(sys.argv[1]) if l.strip() and not l.startswith('#')]
cases=[]
for i,q in enumerate(qs):
    c={"id":i,"dataset":0,"kind":kind,"query":q,"limit":100,"spss":100}
    if kind!='search':
        c.update({"start":S,"end":S+20_000_000_000,"step":1_000_000_000})
        if len(sys.argv)>3: c.update(json.loads(sys.argv[3]))
    cases.append(c)
json.dump({"datasets":[ds],"cases":cases},open(SCR+'/probe/cases.json','w'))
subprocess.run([SCR+'/bin/godiff','-cases',SCR+'/probe/cases.json','-out',SCR+'/probe/out.json'],check=True,stderr=subprocess.DEVNULL)
outs=json.load(open(SCR+'/probe/out.json'))
short={TA:"A",TB:"B",TC:"C"}
for c,o in zip(cases,outs):
    print("Q:",c["query"])
    if o.get("error"): print("   ERR:",o["error"][:200]); continue
    t=o["tempo"]
    if kind=='search':
        for tr in t.get("traces",[]):
            ss=[]
            for s in tr.get("spanSets",[]):
                spans=[(x["spanID"], {kv["key"]:list(kv["value"].values())[0] for kv in x.get("attributes",[])}) for x in s.get("spans",[])]
                ss.append({"m":s.get("matched"),"spans":spans,"attrs":{kv["key"]:list(kv["value"].values())[0] for kv in s.get("attributes",[])}})
            print("   trace",tr["traceID"],tr.get("rootServiceName"),tr.get("rootTraceName"),tr.get("startTimeUnixNano"),tr.get("durationMs"),json.dumps(ss))
            if os.environ.get('FULL'): print('     ', json.dumps(tr))
    else:
        print("   ", json.dumps(t)[:3000])
