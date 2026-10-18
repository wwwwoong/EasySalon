import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeShop,ownerCommand,publicShop} from '../lib/domain.ts';
import {addReservation,availability,bookingSettings,cancelOwnReservation,defaultBookingSettings,manageReservation,ownerReservations,reservationReceipt,validateBookingSettings} from '../lib/reservations.ts';
const now=Date.parse('2026-10-19T09:00:00+09:00');
const start=Date.parse('2026-10-19T10:00:00+09:00');
function setup(){const shop=makeShop('owner');shop.settings.reservations={...defaultBookingSettings,enabled:true,noticeMinutes:0};return shop;}
function input(time=start){return {requestId:crypto.randomUUID(),realName:'홍길동',phone:'010-1234-5678',privacyConsent:true,startsAt:time,serviceIds:['mens-cut'],options:{},hair:{gender:'male',length:'short'}};}
test('booking policy defaults off, respects Korea weekdays, lead time and duration at closing',()=>{
 const old=makeShop('owner');assert.equal(bookingSettings(old).enabled,false);
 const shop=setup();assert.ok(availability(shop,'2026-10-19',['mens-cut'],now).slots.includes(start));
 assert.equal(availability(shop,'2026-10-24',['mens-cut'],now).slots.length,0);
 assert.match(availability(shop,'2026-10-24',['mens-cut'],now).reason,/요일/);
 shop.settings.reservations!.noticeMinutes=120;
 assert.ok(!availability(shop,'2026-10-19',['mens-cut'],now).slots.includes(start));
 assert.ok(availability(shop,'2026-10-19',['color'],now).slots.every(v=>v+80*60000<=Date.parse('2026-10-19T19:00:00+09:00')));
 assert.throws(()=>availability(shop,'2026-02-30',['mens-cut'],now));
 assert.throws(()=>availability(shop,'2027-01-01',['mens-cut'],now));
 assert.throws(()=>validateBookingSettings({...defaultBookingSettings,enabled:true,weekdays:[]}));
 assert.throws(()=>validateBookingSettings({...defaultBookingSettings,weekdays:[1,1]}));
 assert.throws(()=>validateBookingSettings({...defaultBookingSettings,startTime:'19:00',endTime:'10:00'}));
});
test('reservations require contact and consent, snapshot services, and exclude overlapping intervals',()=>{
 const shop=setup();for(const patch of [{realName:''},{realName:'a\n'},{phone:'123'},{privacyConsent:false},{phone:'010abc12345678'}])assert.throws(()=>addReservation(shop,{...input(),...patch},now));
 const req={...input(),serviceIds:['color']};const r=addReservation(shop,req,now);
 assert.equal(r.phone,'01012345678');assert.equal(r.duration,80);
 assert.equal(addReservation(shop,req,now).id,r.id);assert.equal(shop.state.reservations?.length,1);
 assert.throws(()=>addReservation(shop,{...req,realName:'다른이'},now),/같은 예약 요청/);
 assert.throws(()=>addReservation(shop,input(start+30*60000),now),/이미 예약/);
 assert.ok(availability(shop,'2026-10-19',['mens-cut'],now).slots.includes(start+90*60000));
 shop.menu=[];manageReservation(shop,{action:'settings',...defaultBookingSettings},now);
 manageReservation(shop,{action:'checkIn',reservationId:r.id},start-15*60000);
 assert.equal(shop.state.tickets[0].items[0].name,'염색');assert.equal(shop.state.tickets[0].duration,80);
 manageReservation(shop,{action:'checkIn',reservationId:r.id},start);assert.equal(shop.state.tickets.length,1);
 assert.throws(()=>manageReservation(shop,{action:'cancel',reservationId:r.id},start));
 assert.ok(reservationReceipt(shop,r).ticketToken);assert.equal('phone' in reservationReceipt(shop,r),false);
 assert.equal('token' in ownerReservations(shop)[0],false);assert.equal('signature' in ownerReservations(shop)[0],false);
 assert.equal(JSON.stringify(publicShop(shop)).includes('01012345678'),false);
});
test('cancellation releases availability and check-in/no-show have time guards',()=>{
 const shop=setup(),r=addReservation(shop,input(),now);
 assert.throws(()=>manageReservation(shop,{action:'checkIn',reservationId:r.id},now));
 assert.throws(()=>manageReservation(shop,{action:'noShow',reservationId:r.id},now));
 assert.throws(()=>cancelOwnReservation(shop,r.token,start));
 cancelOwnReservation(shop,r.token,now);cancelOwnReservation(shop,r.token,now);
 assert.ok(availability(shop,'2026-10-19',['mens-cut'],now).slots.includes(start));
 assert.throws(()=>manageReservation(shop,{action:'checkIn',reservationId:r.id},start));
 const next=addReservation(shop,input(),now);manageReservation(shop,{action:'noShow',reservationId:next.id},start);
 assert.ok(availability(shop,'2026-10-19',['mens-cut'],now).slots.includes(start));
 const linked=addReservation(shop,input(),now);manageReservation(shop,{action:'checkIn',reservationId:linked.id},start);
 assert.equal(shop.state.tickets[0].status,'waiting');assert.equal(shop.state.tickets[0].displayName,'홍길동');
 ownerCommand(shop,{action:'start',ticketId:shop.state.tickets[0].id},start);
 ownerCommand(shop,{action:'complete',ticketId:shop.state.tickets[0].id,price:18000},start+20*60000);
 assert.equal(ownerReservations(shop).find(v=>v.id===linked.id)?.ticketStatus,'completed');
});
