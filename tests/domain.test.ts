import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeShop,addTicket,ownerCommand,queueSummary,stats,ticketView,publicShop} from '../lib/domain.ts';
const input=(extra={})=>({requestId:crypto.randomUUID(),serviceIds:['mens-cut'],options:{'mens-cut:style':'natural'},consult:false,source:'owner',...extra});
test('catalog snapshots and combination discounts remain fixed after catalog edits',()=>{
 const shop=makeShop('a');const t=addTicket(shop,input({serviceIds:['mens-cut','color'],options:{'color:color':'ash'}}),true);
 assert.equal(t.total,78000);assert.equal(t.duration,100);assert.deepEqual(t.items[1].options,['색상: 애쉬 브라운']);shop.menu[0].price=1;assert.equal(t.items[0].price,18000);
});
test('idempotency is shop scoped and rejects changed requests',()=>{
 const a=makeShop('a'),b=makeShop('b'),i=input();const first=addTicket(a,i,true);assert.equal(addTicket(a,i,true).token,first.token);assert.equal(a.state.tickets.length,1);assert.throws(()=>addTicket(a,{...i,consult:true},true),/내용이 다릅니다/);assert.notEqual(addTicket(b,i,true).token,first.token);
});
test('one stylist state machine rejects concurrent calls, terminal changes and serving cancellation',()=>{
 const shop=makeShop('a');const a=addTicket(shop,input(),true),b=addTicket(shop,input(),true);
 ownerCommand(shop,{action:'call',ticketId:a.id});assert.throws(()=>ownerCommand(shop,{action:'call',ticketId:b.id}),/먼저 완료/);ownerCommand(shop,{action:'start',ticketId:a.id});assert.throws(()=>ownerCommand(shop,{action:'cancel',ticketId:a.id}),/현재 상태/);ownerCommand(shop,{action:'complete',ticketId:a.id});ownerCommand(shop,{action:'complete',ticketId:a.id});assert.throws(()=>ownerCommand(shop,{action:'start',ticketId:a.id}),/종료된/);
});
test('QR approval, holds and admission order keep the waiting queue honest',()=>{
 const shop=makeShop('a');const pending=addTicket(shop,input({source:'qr'}),false);assert.equal(pending.status,'pending');assert.equal(queueSummary(shop).waiting,0);
 const accepted=addTicket(shop,input(),true);ownerCommand(shop,{action:'approve',ticketId:pending.id});assert.equal(ticketView(shop,pending).ahead,1);ownerCommand(shop,{action:'hold',ticketId:accepted.id});assert.equal(ticketView(shop,pending).ahead,0);assert.equal(queueSummary(shop).waiting,1);
});
test('stale work is unknown until remaining duration is refreshed',()=>{
 const shop=makeShop('a');const t=addTicket(shop,input(),true,100000);ownerCommand(shop,{action:'start',ticketId:t.id},100000);
 assert.equal(queueSummary(shop,100000+20*60000).waitMin,null);ownerCommand(shop,{action:'remaining',ticketId:t.id,minutes:5},100000+20*60000);assert.equal(queueSummary(shop,100000+20*60000).waitMin,5);
});
test('consultation completion requires final price and price edits are audited',()=>{
 const shop=makeShop('a'),t=addTicket(shop,input({consult:true}),true);ownerCommand(shop,{action:'start',ticketId:t.id});assert.throws(()=>ownerCommand(shop,{action:'complete',ticketId:t.id}),/최종 금액/);ownerCommand(shop,{action:'complete',ticketId:t.id,price:22000});ownerCommand(shop,{action:'price',ticketId:t.id,price:20000});assert.equal(stats(shop).revenue,20000);assert.equal(t.audit.filter(a=>a.action==='price').length,2);
});
test('Korea day statistics exclude previous day and pending revenue',()=>{
 const now=Date.parse('2026-10-17T00:30:00+09:00'),shop=makeShop('a');const old=addTicket(shop,input(),true,now-7200000);ownerCommand(shop,{action:'start',ticketId:old.id},now-7200000);ownerCommand(shop,{action:'complete',ticketId:old.id},now-3600000);addTicket(shop,input({source:'qr'}),false,now);assert.equal(stats(shop,now).revenue,0);assert.equal(stats(shop,now).workMinutes,0);assert.equal(stats(shop,now).expectedRevenue,18000);
});
test('customer input cannot spoof staff source and public response contains no private data',()=>{
 const shop=makeShop('a');assert.throws(()=>addTicket(shop,input(),false),/권한/);assert.throws(()=>addTicket(shop,input({options:{'mens-cut:style':'injected'}}),true),/옵션/);assert.throws(()=>addTicket(shop,input({serviceIds:['mens-cut','mens-cut']}),true),/메뉴/);
 const view=publicShop(shop);assert.equal('ownerId' in view,false);assert.equal('tickets' in view,false);assert.equal('stats' in view,false);
});
