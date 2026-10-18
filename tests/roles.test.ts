import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeShop,addTicket,ownerCommand,revenueReport,parseReportRange,validateMenu,publicShop} from '../lib/domain.ts';
const input=(extra={})=>({requestId:crypto.randomUUID(),serviceIds:['mens-cut'],options:{},source:'owner',...extra});
test('hair selection snapshots validated length and detects changed retries',()=>{
 const shop=makeShop('owner');const request=input({hair:{gender:'female',length:'long'}}),ticket=addTicket(shop,request,true);
 assert.deepEqual(ticket.hair,{gender:'female',length:'long'});assert.ok(ticket.items[0].options.includes('여성 · 긴 길이'));assert.equal(ticket.total,18000);
 assert.throws(()=>addTicket(shop,{...request,hair:{gender:'female',length:'short'}},true),/내용이 다릅니다/);
 assert.throws(()=>addTicket(shop,input({hair:{gender:'male',length:'long'}}),true),/머리 길이/);
 assert.throws(()=>addTicket(shop,input({hair:{gender:'consult',length:'short'}}),true),/머리 길이/);
 shop.menu[0].hairLengthEnabled=false;assert.deepEqual(addTicket(shop,input({hair:{gender:'male',length:'short'}}),true).items[0].options,[]);
});
test('catalog defaults and explicit hair configuration survive validation',()=>{
 const shop=makeShop('owner');delete shop.menu[0].audience;delete shop.menu[0].hairLengthEnabled;
 const menu=validateMenu(shop.menu);assert.equal(menu[0].audience,'all');assert.equal(menu[0].hairLengthEnabled,true);
 menu[0].audience='female';menu[0].hairLengthEnabled=false;assert.equal(validateMenu(menu)[0].hairLengthEnabled,false);
 assert.throws(()=>validateMenu([{...menu[0],audience:'injected'}]),/메뉴 대상/);
 assert.equal('ownerId' in publicShop(shop),false);
});
test('reports use strict real dates and maximum inclusive range',()=>{
 for(const [from,to] of [['2026-02-30','2026-03-01'],['2026-2-01','2026-03-01'],['2026-10-18','2026-10-17'],['2025-01-01','2026-01-02']])assert.throws(()=>parseReportRange(from,to));
 assert.equal(parseReportRange('2024-01-01','2024-12-31').count,366);
});
test('reports include Korea completion boundaries, final adjustments and discount totals',()=>{
 const shop=makeShop('owner');const start=Date.parse('2026-10-17T00:00:00+09:00');
 const completed=(at:number,extra={})=>{const t=addTicket(shop,input(extra),true,at-60000);ownerCommand(shop,{action:'start',ticketId:t.id},at-60000);ownerCommand(shop,{action:'complete',ticketId:t.id},at);return t;};
 completed(start-1);const combo=completed(start,{serviceIds:['mens-cut','color']});ownerCommand(shop,{action:'price',ticketId:combo.id,price:70000});completed(start+86400000-1);completed(start+86400000);
 const cancelled=addTicket(shop,input(),true,start);ownerCommand(shop,{action:'cancel',ticketId:cancelled.id},start);addTicket(shop,input({source:'qr'}),false,start);
 const report=revenueReport(shop,'2026-10-17','2026-10-18');
 assert.equal(report.revenue,106000);assert.equal(report.completed,3);assert.equal(report.workMinutes,3);assert.equal(report.daily[0].revenue,88000);assert.equal(report.daily[1].revenue,18000);assert.equal(report.items.reduce((sum,i)=>sum+i.revenue,0),report.revenue);assert.ok(report.items.some(i=>i.name==='남성 커트 + 염색'&&i.revenue===70000));
 const empty=revenueReport(shop,'2026-10-19','2026-10-20');assert.equal(empty.revenue,0);assert.equal(empty.daily.length,2);assert.deepEqual(empty.daily.map(d=>d.completed),[0,0]);
});
