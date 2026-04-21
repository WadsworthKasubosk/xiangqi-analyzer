const fs = require('fs');
const path = 'C:/Users/da983/zg002/xiangqi-analyzer/.claude/worktrees/condescending-liskov-059a14/engine/pikafish.js';
const src = fs.readFileSync(path, 'utf8');

const OLD = 'const wrap=fn=>{if(!fn||fn.__uciWrapped)return fn;const wrapped=function(e){if(e&&e.data&&e.data.cmd==="custom"){if(typeof Module!=="undefined"&&typeof Module.onCustomMessage==="function"){Module.onCustomMessage(e.data.userData)}else if(typeof Module!=="undefined"&&Module.queue&&typeof Module.queue.put==="function"){Module.queue.put(e.data.userData)}return}return fn.call(this,e)};wrapped.__uciWrapped=true;return wrapped};let current=self.onmessage;current=wrap(current);try{Object.defineProperty(self,"onmessage",{configurable:true,get(){return current},set(fn){current=wrap(fn)}})}catch(e){self.onmessage=current}';

const NEW = 'self.addEventListener("message",function(e){if(e&&e.data&&e.data.cmd==="custom"){if(typeof Module!=="undefined"&&typeof Module.onCustomMessage==="function"){Module.onCustomMessage(e.data.userData)}else if(typeof Module!=="undefined"&&Module.queue&&typeof Module.queue.put==="function"){Module.queue.put(e.data.userData)}if(typeof e.stopImmediatePropagation==="function")e.stopImmediatePropagation()}},{capture:true})';

const parts = src.split(OLD);
console.log('Matches of OLD:', parts.length - 1);
if (parts.length - 1 !== 1) {
  console.error('ABORT: expected exactly 1 match of OLD snippet');
  process.exit(1);
}
const out = parts.join(NEW);
fs.writeFileSync(path, out, 'utf8');

const v = fs.readFileSync(path, 'utf8');
console.log('OLD still present:', v.includes(OLD));
console.log('NEW present:      ', v.includes(NEW));
console.log('File size:', v.length);
