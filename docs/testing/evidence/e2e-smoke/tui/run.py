import os,pty,termios,fcntl,struct,select,time,json,signal,pathlib,re
root=pathlib.Path('/tmp/atomic-e2e-tui')
node='/Users/aleksejkalina/.volta/tools/image/node/25.7.0/bin/node'
cli='/Users/aleksejkalina/code/atomicbot/atomic-agent/dist/cli/index.js'
results=[]
for name in ['onboarding','main']:
 base=root/name
 env={k:os.environ[k] for k in ['PATH','HOME','USER','TMPDIR'] if k in os.environ}
 env.update({'TERM':'xterm-256color','LANG':'en_US.UTF-8','ATOMIC_AGENT_STATE_DIR':str(base/'state'),'ATOMIC_AGENT_ANALYTICS':'off','ATOMIC_AGENT_UPDATE_CHECK_ON_STARTUP':'false','ATOMIC_AGENT_BROWSER_ENABLED':'false','ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED':'false','ATOMIC_AGENT_GRAMMARS_DIR':'/Users/aleksejkalina/code/atomicbot/atomic-agent/grammars'})
 pid,master=pty.fork()
 if pid==0:
  os.chdir(base/'cwd'); args=[node,cli,'tui','--cwd',str(base/'cwd')]
  args+=['--onboarding'] if name=='onboarding' else ['--skip-llama-setup']
  os.execve(node,args,env)
 fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',32,100,0,0))
 raw=bytearray(); steps=[]
 def pump(seconds):
  until=time.monotonic()+seconds
  while time.monotonic()<until:
   if select.select([master],[],[],0.1)[0]:
    try:
     part=os.read(master,65536)
     if not part: break
     raw.extend(part)
    except OSError: break
 def send(label,data,delay=1):
  steps.append({'label':label,'offset':len(raw)})
  os.write(master,data);pump(delay)
 pump(5); (base/'startup.ansi').write_bytes(raw)
 if name=='onboarding':
  send('finish intro',b' ',.3); send('enter choice',b' ',1.5);(base/'choice.ansi').write_bytes(raw)
  send('ctrl+c arm',b'\x03',0.2);send('ctrl+c quit',b'\x03',1)
 else:
  send('type help',b'/help',.3);send('submit help',b'\r',2);(base/'help.ansi').write_bytes(raw)
  send('type quit',b'/quit',.3);send('submit quit',b'\r',2)
 deadline=time.monotonic()+8;status=None
 while time.monotonic()<deadline:
  ended,value=os.waitpid(pid,os.WNOHANG)
  if ended: status=os.waitstatus_to_exitcode(value);break
  pump(.2)
 killed=False
 if status is None:
  killed=True;os.kill(pid,signal.SIGTERM);pump(2)
  ended,value=os.waitpid(pid,os.WNOHANG)
  if not ended: os.kill(pid,signal.SIGKILL);ended,value=os.waitpid(pid,0)
  status=os.waitstatus_to_exitcode(value)
 os.close(master);(base/'full.ansi').write_bytes(raw)
 text=re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)','',raw.decode(errors='replace'))
 text=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',text)
 (base/'full.txt').write_text(text)
 results.append({'scenario':name,'exitCode':status,'forcedTermination':killed,'bytes':len(raw),'altEntered':b'\x1b[?1049h' in raw,'altExited':b'\x1b[?1049l' in raw,'mouseEnabled':b'\x1b[?1002h' in raw or b'\x1b[?1003h' in raw,'mouseDisabled':b'\x1b[?1002l' in raw or b'\x1b[?1003l' in raw,'steps':steps})
(root/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
