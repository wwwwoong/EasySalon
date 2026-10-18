import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addTicket,makeShop,ownerCommand,publicShop} from '../lib/domain.ts';
import {addReservation,availability,defaultBookingSettings} from '../lib/reservations.ts';
import {initialProfile,schedulerCommand,schedulerState,validateProfile} from '../lib/scheduler.ts';
import {analyzeInterview} from '../lib/scheduler-ai.ts';
const now=Date.parse('2026-10-19T09:00:00+09:00'),start=Date.parse('2026-10-19T10:00:00+09:00');
function setup(staffCount=1,chairs=2){const shop=makeShop('owner');shop.settings.reservations={...defaultBookingSettings,enabled:true,noticeMinutes:0,interval:10};const p=initialProfile(shop);p.chairs=chairs;p.staff=Array.from({length:staffCount},(_,i)=>({...structuredClone(p.staff[0]),id:'staff-'+i,label:'직원 '+i}));p.services.find(s=>s.serviceId==='color')!.stages=[{name:'도포',minutes:20,needsStaff:true,resource:'chair'},{name:'방치',minutes:30,needsStaff:false,resource:'chair'},{name:'세척',minutes:10,needsStaff:true,resource:'wash'},{name:'마무리',minutes:20,needsStaff:true,resource:'chair'}];schedulerCommand(shop,{action:'activate',profile:p,expectedVersion:0},now);return shop;}
const booking=(service='mens-cut',at=start)=>({requestId:crypto.randomUUID(),serviceIds:[service],realName:'예약고객',phone:'01012345678',privacyConsent:true,startsAt:at});
test('a single stylist fits a cut into dye waiting time while preserving finish and cleanup blocks',()=>{
 const shop=setup();const dye=addReservation(shop,booking('color'),now);assert.equal(dye.duration,85);
 const slots=availability(shop,'2026-10-19',['mens-cut'],now).slots;
 assert.ok(slots.includes(start+20*60000));assert.ok(!slots.includes(start+30*60000));
 const cut=addReservation(shop,booking('mens-cut',start+20*60000),now);
 assert.equal(cut.allocation?.staffId,dye.allocation?.staffId);
 assert.equal(dye.allocation?.stages[1].staffId,undefined);assert.equal(dye.allocation?.stages[1].resource,'chair');
 assert.throws(()=>addReservation(shop,booking('mens-cut',start+30*60000),now));
});
test('parallel bookings respect staff skill, chairs, washbasins, and stable assignments',()=>{
 const shop=setup(2,2);const one=addReservation(shop,booking(),now),two=addReservation(shop,booking(),now);
 assert.notEqual(one.allocation?.staffId,two.allocation?.staffId);assert.throws(()=>addReservation(shop,booking(),now));
 const dyes=setup(2,2);addReservation(dyes,booking('color'),now);
 // Both colors would need the sole washbasin at the same time.
 assert.throws(()=>addReservation(dyes,booking('color'),now));
 dyes.state.scheduler!.active!.washBasins=2;addReservation(dyes,booking('color'),now);
 assert.throws(()=>addReservation(dyes,booking('mens-cut',start+20*60000),now));
 const skill=setup(2);skill.state.scheduler!.active!.staff.forEach(s=>s.serviceIds=['color']);
 assert.equal(availability(skill,'2026-10-19',['mens-cut'],now).slots.length,0);
 const legacy=makeShop('owner');legacy.settings.reservations={...defaultBookingSettings,enabled:true,noticeMinutes:0};addReservation(legacy,booking('color'),now);const profile=initialProfile(legacy);profile.chairs=3;profile.staff.push({...structuredClone(profile.staff[0]),id:'second'});schedulerCommand(legacy,{action:'activate',profile,expectedVersion:0},now);
 assert.ok(!availability(legacy,'2026-10-19',['mens-cut'],now).slots.includes(start));
});
test('feedback requires repeated evidence, approval uses version lease, and existing allocations never change',()=>{
 const shop=setup(),r=addReservation(shop,booking(),now),snapshot=JSON.stringify(r);
 for(let i=0;i<2;i++)schedulerCommand(shop,{action:'feedback',requestId:crypto.randomUUID(),serviceId:'mens-cut',stageIndex:0,kind:'tight',actualMinutes:30,note:'도포보다 커트가 늦었어요'},now);
 assert.throws(()=>schedulerCommand(shop,{action:'analyze'},now),/근거가 부족/);
 schedulerCommand(shop,{action:'feedback',requestId:crypto.randomUUID(),serviceId:'mens-cut',stageIndex:0,kind:'late',actualMinutes:28,note:''},now);
 schedulerCommand(shop,{action:'analyze'},now);schedulerCommand(shop,{action:'analyze'},now);
 const proposal=schedulerState(shop).proposals[0];assert.equal(schedulerState(shop).proposals.length,1);assert.equal(proposal.profile.services.find(s=>s.serviceId==='mens-cut')!.stages[0].minutes,25);
 assert.equal(schedulerState(shop).active!.services.find(s=>s.serviceId==='mens-cut')!.stages[0].minutes,20);
 assert.throws(()=>schedulerCommand(shop,{action:'apply',proposalId:proposal.id,expectedVersion:0},now),/変更|변경/);
 schedulerCommand(shop,{action:'apply',proposalId:proposal.id,expectedVersion:1},now);assert.equal(schedulerState(shop).version,2);assert.equal(JSON.stringify(shop.state.reservations![0]),snapshot);
 schedulerCommand(shop,{action:'restore',version:1,expectedVersion:2},now);assert.equal(schedulerState(shop).version,3);assert.equal(schedulerState(shop).active!.services.find(s=>s.serviceId==='mens-cut')!.stages[0].minutes,20);
 const bad=structuredClone(schedulerState(shop).active!);bad.staff[0].id='replacement';assert.throws(()=>schedulerCommand(shop,{action:'activate',profile:bad,expectedVersion:3},now),/충돌/);
 assert.ok(!JSON.stringify(publicShop(shop)).includes('feedback'));
});
test('multi-stylist work starts independently and profile validation rejects unsafe definitions',()=>{
 const shop=setup(2);const a=addTicket(shop,{requestId:crypto.randomUUID(),source:'owner',serviceIds:['mens-cut']},true,start),b=addTicket(shop,{requestId:crypto.randomUUID(),source:'owner',serviceIds:['mens-cut']},true,start),c=addTicket(shop,{requestId:crypto.randomUUID(),source:'owner',serviceIds:['mens-cut']},true,start);
 ownerCommand(shop,{action:'start',ticketId:a.id},start);ownerCommand(shop,{action:'start',ticketId:b.id},start);assert.notEqual(a.staffId,b.staffId);assert.throws(()=>ownerCommand(shop,{action:'start',ticketId:c.id},start));
 const p=initialProfile(shop);p.staff.push(structuredClone(p.staff[0]));assert.throws(()=>validateProfile(p,shop));
 const p2=initialProfile(shop);p2.services[0].stages[0].needsStaff=false;assert.throws(()=>validateProfile(p2,shop));
});
test('AI transport excludes reservation identities, validates output, and never activates a draft',async()=>{
 const shop=setup();addReservation(shop,{...booking(),realName:'PRIVATE_CUSTOMER',phone:'01098765432'},now);const before=JSON.stringify(shop.state.scheduler?.active);
 const fake=(async(_url:unknown,init:RequestInit|undefined)=>{const body=JSON.parse(String(init?.body));assert.equal(body.store,false);assert.ok(!String(init?.body).includes('PRIVATE_CUSTOMER'));assert.ok(!String(init?.body).includes('01098765432'));assert.ok(!String(init?.body).includes('010-1234-5678'));assert.equal(body.text.format.strict,true);return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({profile:schedulerState(shop).draft,summary:'운영표 초안',questions:['방치 중 확인이 필요한가요?']})}]}]});}) as typeof fetch;
 const result=await analyzeInterview(shop,'직원 두 명, 연락처 010-1234-5678',{key:'test-secret',model:'test-model',fetcher:fake});assert.equal(result.summary,'운영표 초안');assert.equal(JSON.stringify(shop.state.scheduler?.active),before);
 const broken=(async()=>Response.json({status:'completed',output:[{content:[{type:'output_text',text:'{"profile":{}}'}]}]})) as typeof fetch;
 await assert.rejects(()=>analyzeInterview(shop,'테스트',{key:'x',model:'test',fetcher:broken}),/기준에 맞지/);
});

test('manual waiting stage frees a stylist for a cut and blocks a premature staffed return',()=>{
 const shop=setup(1,2);const dye=addTicket(shop,{requestId:crypto.randomUUID(),source:'owner',serviceIds:['color']},true,start),cut=addTicket(shop,{requestId:crypto.randomUUID(),source:'owner',serviceIds:['mens-cut']},true,start);
 ownerCommand(shop,{action:'start',ticketId:dye.id},start);
 assert.throws(()=>ownerCommand(shop,{action:'start',ticketId:cut.id},start+10*60000));
 ownerCommand(shop,{action:'stageNext',ticketId:dye.id,expectedStageIndex:0},start+20*60000);
 ownerCommand(shop,{action:'stageNext',ticketId:dye.id,expectedStageIndex:0},start+20*60000);assert.equal(dye.stageIndex,1);
 ownerCommand(shop,{action:'start',ticketId:cut.id},start+20*60000);
 assert.equal(dye.staffId,cut.staffId);assert.equal(dye.stages?.[dye.stageIndex!].needsStaff,false);
 assert.throws(()=>ownerCommand(shop,{action:'stageNext',ticketId:dye.id,expectedStageIndex:dye.stageIndex??0},start+30*60000),/다른 고객/);
 ownerCommand(shop,{action:'complete',ticketId:cut.id},start+45*60000);
 ownerCommand(shop,{action:'stageNext',ticketId:dye.id,expectedStageIndex:dye.stageIndex??0},start+50*60000);assert.equal(dye.stages?.[dye.stageIndex!].resource,'wash');
});
