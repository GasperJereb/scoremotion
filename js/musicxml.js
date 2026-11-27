'use strict';
/* ScoreMotion: local MusicXML timing import. Original PDF remains the engraving. */
(() => {
 const input=document.getElementById('musicXmlIn'), status=document.getElementById('musicXmlStatus'), apply=document.getElementById('musicXmlApply');
 let model=null, generation=0;
 const children=(el,name)=>Array.from(el.children).filter(e=>e.localName===name);
 const child=(el,name)=>children(el,name)[0];
 const number=(el,name,fallback=0)=>{const e=child(el,name);return e&&Number.isFinite(Number(e.textContent))?Number(e.textContent):fallback;};
 function xml(text){const d=new DOMParser().parseFromString(text,'application/xml');if(d.querySelector('parsererror'))throw Error('Invalid XML');return d;}
 async function unpack(file){
   if(!/\.mxl$/i.test(file.name))return file.text();
   const bytes=new Uint8Array(await file.arrayBuffer()), v=new DataView(bytes.buffer);
   let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(v.getUint32(i,true)===0x06054b50&&i+22+v.getUint16(i+20,true)===bytes.length){end=i;break;}
   if(end<0)throw Error('Invalid MXL archive');
   const count=v.getUint16(end+10,true);let pos=v.getUint32(end+16,true);const entries=new Map(), decoder=new TextDecoder();
   for(let i=0;i<count;i++){if(pos+46>bytes.length||v.getUint32(pos,true)!==0x02014b50)throw Error('Invalid ZIP directory');const n=v.getUint16(pos+28,true),x=v.getUint16(pos+30,true),c=v.getUint16(pos+32,true);const name=decoder.decode(bytes.subarray(pos+46,pos+46+n));entries.set(name,{method:v.getUint16(pos+10,true),flags:v.getUint16(pos+8,true),size:v.getUint32(pos+20,true),raw:v.getUint32(pos+24,true),offset:v.getUint32(pos+42,true)});pos+=46+n+x+c;}
   async function read(name){const e=entries.get(name);if(!e||e.raw>50*1024*1024||(e.flags&1))throw Error('Missing, encrypted or oversized MXL entry');const p=e.offset;if(p+30>bytes.length||v.getUint32(p,true)!==0x04034b50)throw Error('Invalid ZIP entry');const start=p+30+v.getUint16(p+26,true)+v.getUint16(p+28,true);if(start+e.size>bytes.length)throw Error('Invalid ZIP size');let data=bytes.subarray(start,start+e.size);if(e.method===8){if(typeof DecompressionStream==='undefined')throw Error('Use uncompressed MusicXML in this browser');const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();let chunks=[],len=0;while(true){const {done,value}=await reader.read();if(done)break;len+=value.length;if(len>50*1024*1024){await reader.cancel();throw Error('MXL entry too large');}chunks.push(value);}return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());}if(e.method!==0)throw Error('Unsupported ZIP compression');return decoder.decode(data);}
   const manifest=xml(await read('META-INF/container.xml')), root=Array.from(manifest.getElementsByTagNameNS('*','rootfile'))[0];if(!root)throw Error('Missing MXL rootfile');return read(root.getAttribute('full-path'));
 }
 function parse(text){
   const doc=xml(text), root=doc.documentElement;if(root.localName!=='score-partwise')throw Error('Only score-partwise MusicXML is supported');
   const parts=children(root,'part');if(!parts.length)throw Error('No parts');
   const measures=children(parts[0],'measure');if(!measures.length)throw Error('No measures');
   if(measures.length>20000)throw Error('Too many measures');
   let divisions=1,bpm=120,seconds=0,explicitTempo=false;const starts=[],systems=[0],warnings=[];
   const repeats=Array.from(doc.getElementsByTagNameNS('*','repeat')).length||Array.from(doc.getElementsByTagNameNS('*','ending')).length||Array.from(doc.getElementsByTagNameNS('*','sound')).some(e=>['dacapo','dalsegno','tocoda','fine'].some(a=>e.hasAttribute(a)));
   for(let i=0;i<measures.length;i++){
     const m=measures[i];starts.push(seconds);
     if(i&&children(m,'print').some(p=>p.getAttribute('new-system')==='yes'||p.getAttribute('new-page')==='yes'))systems.push(seconds);
     let cursor=0,max=0,last=0;const changes=[];
     for(const e of m.children){
       switch(e.localName){
       case 'attributes':divisions=number(e,'divisions',divisions);if(!(divisions>0))throw Error('Invalid divisions');break;
       case 'backup':cursor=Math.max(0,cursor-number(e,'duration')/divisions);break;
       case 'forward':cursor+=number(e,'duration')/divisions;max=Math.max(max,cursor);break;
       case 'note':{const d=number(e,'duration')/divisions;if(child(e,'grace'))break;if(child(e,'chord')){max=Math.max(max,last+d);break;}last=cursor;cursor+=d;max=Math.max(max,cursor);break;}
       case 'direction':{const sound=child(e,'sound');const tempo=Number(sound?.getAttribute('tempo'));if(tempo>0){changes.push([Math.max(0,cursor+number(e,'offset')/divisions),tempo]);explicitTempo=true;}break;}
       case 'sound':{const tempo=Number(e.getAttribute('tempo'));if(tempo>0){changes.push([cursor,tempo]);explicitTempo=true;}break;}
       }
     }
     let previous=0;for(const [at,value] of changes.sort((a,b)=>a[0]-b[0])){const t=Math.min(max,at);seconds+=(t-previous)*60/bpm;previous=t;bpm=value;}seconds+=(max-previous)*60/bpm;
   }
   if(!explicitTempo)warnings.push('No written playback tempo; assuming 120 BPM.');
   if(repeats)warnings.push('Repeats or jumps detected; automatic timing disabled.');
   if(!(seconds>0))throw Error('No timed notes');
   return {measures:measures.length,systems,seconds,repeats,warnings,parts:parts.length};
 }
 input.addEventListener('change',async()=>{const token=++generation;model=null;apply.disabled=true;const file=input.files[0];if(!file){status.textContent='No MusicXML loaded.';return;}status.textContent='Reading MusicXML…';try{if(file.size>50*1024*1024)throw Error('File exceeds 50 MB');const m=parse(await unpack(file));if(token!==generation)return;model=m;status.textContent=m.measures+' measures · '+m.parts+' parts · '+m.systems.length+' written systems · '+m.seconds.toFixed(1)+' s. '+m.warnings.join(' ');apply.disabled=!!m.repeats;}catch(e){if(token===generation)status.textContent='MusicXML: '+e.message;}});
 apply.addEventListener('click',()=>{
   if(!model||model.repeats)return;
   if(!S.pdf||!sysOn()){toast('Load the matching PDF and select System layout first.');return;}
   if(sysBusy()){toast('Wait for system detection to finish.');return;}
   const score=S.spreads.map((s,i)=>({s,i})).filter(x=>x.s[1]>=0);
   if(score.length!==model.systems.length){toast('MusicXML and PDF system counts differ. Check the system selections.');return;}
   if(score.length<2){toast('At least two matching systems are needed.');return;}
   if(!confirm('Replace the current system timing markers with approximate MusicXML timing? The change can be undone.'))return;
   const lo=score[0].i===0?S.vStart:S.turns[score[0].i-1], last=score[score.length-1].i, hi=last<S.turns.length?S.turns[last]:vEnd();
   if(!(hi>lo)){toast('Invalid video duration.');return;}
   pushHistory();for(let i=1;i<score.length;i++){const k=score[i].i-1;S.turns[k]=lo+(hi-lo)*model.systems[i]/model.seconds;S.ph[k]=false;}S.turnsEdited=true;normalizeTurns();onTurnsChanged();updateTimeUI(true);toast('Approximate MusicXML timing applied. Check against the recording.');
 });
})();
