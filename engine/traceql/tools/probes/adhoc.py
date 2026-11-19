# adhoc.py cases.json dataset kind query [start end step]: run Tempo on one dataset of a case file
import json, subprocess, sys
import os
SCR=os.environ['VIZ_TQ_WORK']  # a scratch directory holding bin/godiff
d=json.load(open(sys.argv[1])); ds=d["datasets"][int(sys.argv[2])]
kind=sys.argv[3]; q=sys.argv[4]
c={"id":0,"dataset":0,"kind":kind,"query":q,"limit":100000,"spss":100000}
if kind!="search": c.update({"start":int(sys.argv[5]),"end":int(sys.argv[6]),"step":int(sys.argv[7])})
json.dump({"datasets":[ds],"cases":[c]},open(SCR+'/work/adhoc.json','w'))
subprocess.run([SCR+'/bin/godiff','-cases',SCR+'/work/adhoc.json','-out',SCR+'/work/adhoc_out.json'],check=True,stderr=subprocess.DEVNULL)
o=json.load(open(SCR+'/work/adhoc_out.json'))[0]
print(json.dumps(o.get("tempo") or o.get("error")))
