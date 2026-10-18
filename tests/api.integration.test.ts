import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handleApi } from '../lib/api.ts';
import { type Shop, type Ticket, stats, publicShop, makeShop } from '../lib/domain.ts';
import { insertShop } from '../lib/repository.ts';
type TestPayload = { shops: (Pick<Shop, 'id' | 'name' | 'subtitle'> & {ownerId?:string})[]; shop: ReturnType<typeof publicShop>; tickets: Ticket[]; ticket: Ticket; stats: ReturnType<typeof stats>; notifications: {channel:string}[]; role:string; availableModes:string[]; platform:{brandName:string;accentColor:string;announcement:string;maintenance:boolean}; revenue:number; daily:{date:string;revenue:number;completed:number}[]; membership:{token:string;cardCode:string}; member:{cardCode:string;nickname:string;stamps:number;lifetimeVisits:number}; members:{id:string;cardCode:string;nickname:string;stamps:number;lifetimeVisits:number}[]; history:{kind:string;delta:number;at:number}[] }; 

function fixture(config: {masterUserIds:string[];schedulerAI?:import('../lib/scheduler-ai.ts').SchedulerAI} = {masterUserIds:[]}) {
  const sqlite = new DatabaseSync(':memory:');
  const migrationDir=new URL('../drizzle/',import.meta.url);
  for(const file of readdirSync(migrationDir).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(file,migrationDir),'utf8'));
  for(const ownerId of ['owner-a','owner-b']) {
    const shop=makeShop(ownerId);
    sqlite.prepare('INSERT INTO shops (id,owner_id,name,subtitle,menu,settings,state,revision,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(shop.id,shop.ownerId,shop.name,shop.subtitle,JSON.stringify(shop.menu),JSON.stringify(shop.settings),JSON.stringify(shop.state),shop.revision,shop.updatedAt);
  }
  const adapter = {
    prepare(sql: string) {
      let values: (string | number | null)[] = [];
      const statement = {
        bind(...bindings: (string | number | null)[]) { values = bindings; return statement; },
        async first(column?: string) {
          const row = sqlite.prepare(sql).get(...values);
          return column && row ? row[column] : row ?? null;
        },
        async all() { return { results: sqlite.prepare(sql).all(...values), success: true, meta: {} }; },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  async function request(path: string, method = 'GET', body?: unknown, user: string | null = 'owner-a', origin?: string) {
    const headers: Record<string, string> = {};
    if (user) headers['oai-authenticated-user-id'] = user;
    if (origin) headers.origin = origin;
    if (body) headers['content-type'] = 'application/json';
    const response = await handleApi(new Request('https://salon.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), adapter, config);
    return { status: response.status, data: await response.json() as TestPayload, headers: response.headers };
  }
  const ticket = (source = 'owner') => ({ requestId: crypto.randomUUID(), source, serviceIds: ['mens-cut'], options: {}, consult: false });
  return { sqlite, request, ticket, adapter };
}

test('HTTP contract isolates owners, public projections, and token views', async () => {
  const { sqlite, request, ticket } = fixture();
  try {
    assert.equal((await request('/api/salons', 'GET', undefined, null)).status, 401);
    const a = await request('/api/salons', 'POST', { action: 'init' });
    assert.equal(a.status, 200);
    assert.equal(a.data.shops.length, 1);
    assert.deepEqual((await request('/api/salons', 'POST', { action: 'init' })).data.shops, a.data.shops);
    const id = a.data.shops[0].id;
    await request('/api/salons', 'POST', { action: 'init' }, 'owner-b');
    assert.equal((await request(`/api/salons/${id}/owner`, 'GET', undefined, 'owner-b')).status, 403);
    assert.equal((await request(`/api/salons/${id}/owner`, 'PATCH', { action: 'settings', phase: 'closed' }, 'owner-b')).status, 403);
    const publicResponse = await request(`/api/salons/${id}`, 'GET', undefined, null);
    assert.equal(publicResponse.status, 200);
    assert.equal(JSON.stringify(publicResponse.data).includes('ownerId'), false);
    assert.equal(JSON.stringify(publicResponse.data).includes('tickets'), false);
    assert.match(publicResponse.headers.get('cache-control') ?? '', /no-store/);
    assert.equal((await request(`/api/salons/${id}/tickets`, 'POST', ticket(), null)).status, 403);
    const created = await request(`/api/salons/${id}/tickets`, 'POST', ticket('qr'), null);
    assert.equal(created.status, 201);
    assert.equal(created.data.ticket.status, 'pending');
    const mine = await request('/api/tickets/' + created.data.ticket.token, 'GET', undefined, null);
    assert.equal(mine.status, 200);
    assert.equal(mine.data.ticket.number, created.data.ticket.number);
    assert.equal(mine.data.ticket.requestId, undefined);
    assert.equal((await request('/api/tickets/' + crypto.randomUUID() + crypto.randomUUID(), 'GET', undefined, null)).status, 404);
    assert.equal((await request(`/api/salons/${id}/owner`, 'PATCH', { action: 'settings', phase: 'closed' }, 'owner-a', 'https://evil.test')).status, 403);
  } finally { sqlite.close(); }
});

test('real SQL CAS keeps simultaneous admissions and request retries unique', async () => {
  const { sqlite, request, ticket } = fixture();
  try {
    const id = (await request('/api/salons', 'POST', { action: 'init' })).data.shops[0].id;
    const original = ticket();
    const responses = await Promise.all([
      request(`/api/salons/${id}/tickets`, 'POST', original),
      request(`/api/salons/${id}/tickets`, 'POST', original),
      request(`/api/salons/${id}/tickets`, 'POST', ticket()),
      request(`/api/salons/${id}/tickets`, 'POST', ticket()),
    ]);
    assert.deepEqual(responses.map(r => r.status), [201, 201, 201, 201]);
    assert.equal(responses[0].data.ticket.token, responses[1].data.ticket.token);
    const owner = (await request(`/api/salons/${id}/owner`)).data;
    assert.equal(owner.tickets.length, 3);
    assert.equal(new Set(owner.tickets.map((t: { number: number }) => t.number)).size, 3);
    const conflict = await request(`/api/salons/${id}/tickets`, 'POST', { ...original, serviceIds: ['color'] });
    assert.equal(conflict.status, 409);
  } finally { sqlite.close(); }
});

test('service snapshots, completed totals, and menu edits follow HTTP lifecycle', async () => {
  const { sqlite, request, ticket } = fixture();
  try {
    const shops = (await request('/api/salons', 'POST', { action: 'init' })).data.shops;
    const id = shops[0].id;
    await request(`/api/salons/${id}/tickets`, 'POST', ticket());
    let owner = (await request(`/api/salons/${id}/owner`)).data;
    const current = owner.tickets[0];
    assert.equal(owner.stats.revenue, 0);
    const oldTotal = current.total;
    const menu = structuredClone(owner.shop.menu);
    menu[0].price = 99000;
    assert.equal((await request(`/api/salons/${id}/owner`, 'PATCH', { action: 'menu', menu })).status, 200);
    owner = (await request(`/api/salons/${id}/owner`)).data;
    assert.equal(owner.tickets[0].total, oldTotal);
    assert.equal((await request(`/api/salons/${id}/owner`, 'PATCH', { action: 'call', ticketId: current.id })).status, 200);
    const call = (await request('/api/tickets/' + current.token)).data;
    assert.equal(call.notifications[0].channel, 'in-app');
    assert.equal((await request(`/api/salons/${id}/owner`, 'PATCH', { action: 'start', ticketId: current.id })).status, 200);
    assert.equal((await request(`/api/salons/${id}/owner`, 'PATCH', { action: 'cancel', ticketId: current.id })).status, 409);
    assert.equal((await request(`/api/salons/${id}/owner`, 'PATCH', { action: 'complete', ticketId: current.id })).status, 200);
    assert.equal((await request(`/api/salons/${id}/owner`, 'PATCH', { action: 'complete', ticketId: current.id })).status, 200);
    owner = (await request(`/api/salons/${id}/owner`)).data;
    assert.equal(owner.stats.completed, 1);
    assert.equal(owner.stats.revenue, oldTotal);
    const otherId=(await request('/api/salons','POST',{action:'init'},'owner-b')).data.shops[0].id;
    const other = (await request(`/api/salons/${otherId}/owner`,'GET',undefined,'owner-b')).data;
    assert.equal(other.tickets.length, 0);
    assert.equal(other.stats.revenue, 0);
    await request(`/api/salons/${id}/owner`, 'PATCH', { action: 'settings', phase: 'closed' });
    assert.equal((await request(`/api/salons/${id}`)).data.shop.summary.congestion, '마감');
    assert.equal((await request(`/api/salons/${id}/tickets`, 'POST', ticket('qr'), null)).status, 409);
  } finally { sqlite.close(); }
});


test('each owner manages only the assigned salon including legacy sample rows', async () => {
  const {sqlite,request,ticket,adapter}=fixture();
  try {
    const a=(await request('/api/salons','POST',{action:'init'})).data.shops[0];
    const b=(await request('/api/salons','POST',{action:'init'},'owner-b')).data.shops[0];
    assert.deepEqual((await request('/api/salons')).data.shops.map(s=>s.id),[a.id]);
    assert.deepEqual((await request('/api/salons','GET',undefined,'owner-b')).data.shops.map(s=>s.id),[b.id]);
    assert.equal((await request('/api/salons','POST',{action:'create',name:'Other'})).status,409);
    const legacy=makeShop('owner-a','예전 두 번째 샘플');legacy.id='zzz-legacy-sample';await insertShop(adapter,legacy);
    assert.deepEqual((await request('/api/salons')).data.shops.map(s=>s.id),[a.id]);
    assert.equal((await request(`/api/salons/${legacy.id}/owner`)).status,403);
    assert.equal((await request(`/api/salons/${legacy.id}/tickets`,'POST',ticket())).status,403);
    for (const change of [{action:'settings',phase:'closed'},{action:'menu',menu:[]},{action:'price',ticketId:'fake',price:1}]) {
      assert.equal((await request(`/api/salons/${b.id}/owner`,'PATCH',change)).status,403);
    }
    const ownB=(await request(`/api/salons/${b.id}/owner`,'GET',undefined,'owner-b')).data;
    assert.equal(ownB.shop.settings.phase,'open');assert.ok(ownB.shop.menu.length>0);assert.equal(ownB.tickets.length,0);
    assert.equal((await request(`/api/salons/${b.id}/tickets`,'POST',ticket())).status,403);
  } finally {sqlite.close();}
});

test('adding and removing catalog services preserves earlier ticket snapshots', async () => {
  const {sqlite,request,ticket}=fixture();
  try {
    const id=(await request('/api/salons','POST',{action:'init'})).data.shops[0].id;
    const owner=(await request(`/api/salons/${id}/owner`)).data;
    const added={id:crypto.randomUUID(),name:'학생 커트',description:'학생을 위한 커트',category:'커트',icon:'scissors',price:15000,duration:20,options:[]};
    const menu=[...owner.shop.menu,added];
    assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',{action:'menu',menu})).status,200);
    const created=await request(`/api/salons/${id}/tickets`,'POST',{...ticket(),serviceIds:[added.id]});
    assert.equal(created.status,201);assert.equal(created.data.ticket.total,15000);
    assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',{action:'menu',menu:owner.shop.menu})).status,200);
    const snapshot=(await request('/api/tickets/'+created.data.ticket.token)).data.ticket;
    assert.equal(snapshot.items[0].name,'학생 커트');assert.equal(snapshot.total,15000);assert.equal(snapshot.duration,20);
    assert.equal((await request(`/api/salons/${id}/tickets`,'POST',{...ticket(),serviceIds:[added.id]})).status,400);
    assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',{action:'menu',menu:[]})).status,200);
    assert.deepEqual((await request(`/api/salons/${id}`)).data.shop.menu,[]);
    assert.equal((await request('/api/tickets/'+created.data.ticket.token)).data.ticket.total,15000);
  } finally {sqlite.close();}
});

test('master capability comes only from server allowlist and manages all salons', async () => {
  const {sqlite,request,ticket}=fixture({masterUserIds:['developer']});
  try {
    assert.equal((await request('/api/session')).data.role,'owner');
    assert.equal((await request('/api/session','GET',undefined,null)).data.role,'customer');
    assert.equal((await request('/api/session?role=master')).data.role,'owner');
    assert.equal((await request('/api/master')).status,403);
    assert.equal((await request('/api/master','GET',undefined,null)).status,401);
    assert.equal((await request('/api/salons','POST',{action:'init'},'stranger')).status,403);
    const session=(await request('/api/session','GET',undefined,'developer')).data;
    assert.equal(session.role,'master');assert.ok(session.availableModes.includes('master'));
    const master=(await request('/api/master','GET',undefined,'developer')).data;
    assert.equal(master.shops.length,2);
    assert.equal((await request('/api/salons','GET',undefined,'developer')).data.shops.length,2);
    const other=master.shops.find(s=>s.ownerId==='owner-b')!;
    assert.equal((await request(`/api/salons/${other.id}/owner`,'GET',undefined,'developer')).status,200);
    assert.equal((await request(`/api/salons/${other.id}/owner`,'GET')).status,403);
    assert.equal((await request(`/api/salons/${other.id}/owner`,'PATCH',{action:'settings',phase:'paused'},'developer')).status,200);
    assert.equal((await request(`/api/salons/${other.id}/owner`,'PATCH',{action:'settings',phase:'open'},'developer')).status,200);
    assert.equal((await request(`/api/salons/${other.id}/tickets`,'POST',ticket(),'developer')).status,201);
    const created=await request('/api/master','POST',{action:'create',name:'새 살롱',ownerId:'owner-c'},'developer');
    assert.equal(created.status,201);
    const c=(await request('/api/salons','GET',undefined,'owner-c')).data.shops[0];
    assert.equal(c.name,'새 살롱');
    assert.equal((await request(`/api/salons/${c.id}/owner`,'GET')).status,403);
    assert.equal((await request('/api/master','PATCH',{action:'shop',shopId:c.id,name:'수정 살롱',subtitle:'새 소개',ownerId:'owner-d'},'developer')).status,200);
    assert.equal((await request(`/api/salons/${c.id}/owner`,'GET',undefined,'owner-c')).status,403);
    assert.equal((await request(`/api/salons/${c.id}/owner`,'GET',undefined,'owner-d')).data.shop.name,'수정 살롱');
    assert.equal((await request('/api/master','PATCH',{action:'shop',shopId:c.id,name:'x',subtitle:'',ownerId:'owner-a'},'developer')).status,409);
  } finally {sqlite.close();}
});

test('platform settings are master-only and maintenance blocks new admissions', async () => {
  const {sqlite,request,ticket}=fixture({masterUserIds:['developer']});
  try {
    const id=(await request('/api/salons')).data.shops[0].id;
    const before=ticket('qr');
    assert.equal((await request(`/api/salons/${id}/tickets`,'POST',before,null)).status,201);
    const update={action:'platform',brandName:'새 순서',accentColor:'#335544',announcement:'내일 운영 안내',maintenance:true};
    assert.equal((await request('/api/master','PATCH',update)).status,403);
    assert.equal((await request('/api/master','PATCH',update,'developer')).status,200);
    const session=(await request('/api/session','GET',undefined,null)).data;
    assert.equal(session.platform.brandName,'새 순서');assert.equal(session.platform.maintenance,true);
    assert.equal((await request(`/api/salons/${id}/tickets`,'POST',ticket('qr'),null)).status,503);
    assert.equal((await request(`/api/salons/${id}/owner`)).status,200);
    assert.equal((await request('/api/master','PATCH',{...update,accentColor:'javascript:alert(1)'},'developer')).status,400);
    assert.equal((await request('/api/master','PATCH',{...update,maintenance:false},'developer')).status,200);
    assert.equal((await request(`/api/salons/${id}/tickets`,'POST',ticket('qr'),null)).status,201);
  } finally {sqlite.close();}
});

test('period report endpoints enforce salon permissions and validate dates', async () => {
  const {sqlite,request}=fixture({masterUserIds:['developer']});
  try {
    const id=(await request('/api/salons')).data.shops[0].id;
    const path=`/api/salons/${id}/reports?from=2026-10-01&to=2026-10-17`;
    const report=await request(path);
    assert.equal(report.status,200);assert.equal(report.data.revenue,0);assert.equal(report.data.daily.length,17);
    assert.equal((await request(path,'GET',undefined,'owner-b')).status,403);
    assert.equal((await request(path,'GET',undefined,null)).status,401);
    assert.equal((await request(path,'GET',undefined,'developer')).status,200);
    assert.equal((await request(`/api/salons/${id}/reports?from=2026-02-30&to=2026-03-01`)).status,400);
    assert.equal((await request(`/api/salons/${id}/reports?from=2026-10-17&to=2026-10-01`)).status,400);
    assert.equal((await request(`/api/salons/${id}/reports?from=2020-01-01&to=2026-10-17`)).status,400);
  } finally {sqlite.close();}
});

test('gender and hair length persist in ticket snapshots and retry fingerprint', async () => {
  const {sqlite,request,ticket}=fixture();
  try {
    const id=(await request('/api/salons')).data.shops[0].id;
    const input={...ticket(),hair:{gender:'female',length:'long'}};
    const created=await request(`/api/salons/${id}/tickets`,'POST',input);
    assert.equal(created.status,201);
    const own=(await request(`/api/salons/${id}/owner`)).data.tickets[0];
    assert.equal(own.hair?.gender,'female');assert.equal(own.hair?.length,'long');
    assert.ok(own.items[0].options.some(x=>x.includes('여성')));
    assert.equal((await request(`/api/salons/${id}/tickets`,'POST',{...input,hair:{gender:'female',length:'short'}})).status,409);
    assert.equal((await request(`/api/salons/${id}/tickets`,'POST',{...ticket(),hair:{gender:'male',length:'long'}})).status,400);
    assert.equal((await request(`/api/salons/${id}/tickets`,'POST',{...ticket(),hair:{gender:'consult',length:'long'}})).status,400);
    const menu=(await request(`/api/salons/${id}/owner`)).data.shop.menu;
    menu[0]={...menu[0],audience:'male',hairLengthEnabled:false};
    assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',{action:'menu',menu})).status,200);
    const saved=(await request(`/api/salons/${id}/owner`)).data.shop.menu[0];
    assert.equal(saved.audience,'male');assert.equal(saved.hairLengthEnabled,false);
    assert.equal((await request(`/api/salons/${id}/owner`)).data.tickets[0].hair?.length,'long');
  } finally {sqlite.close();}
});

test('simultaneous master assignments cannot grant two salons to one ordinary owner', async () => {
  const {sqlite,request}=fixture({masterUserIds:['developer']});
  try {
    const creates=await Promise.all([1,2].map(i=>request('/api/master','POST',{action:'create',name:`동시 ${i}`,ownerId:'new-owner'},'developer')));
    assert.deepEqual(creates.map(r=>r.status).sort(),[201,409]);
    const all=(await request('/api/master','GET',undefined,'developer')).data.shops;
    assert.equal(all.filter(s=>s.ownerId==='new-owner').length,1);
    const first=(await request('/api/master','POST',{action:'create',name:'미배정 1'},'developer')).data.shop;
    const second=(await request('/api/master','POST',{action:'create',name:'미배정 2'},'developer')).data.shop;
    const assignments=await Promise.all([first,second].map(s=>request('/api/master','PATCH',{action:'shop',shopId:s.id,name:s.name,subtitle:'',ownerId:'assigned-owner'},'developer')));
    assert.deepEqual(assignments.map(r=>r.status).sort(),[200,409]);
    const latest=(await request('/api/master','GET',undefined,'developer')).data.shops;
    assert.equal(latest.filter(s=>s.ownerId==='assigned-owner').length,1);
  } finally {sqlite.close();}
});

test('guest names, nicknames and salon introduction stay in their authorized projections', async () => {
  const {sqlite,request,ticket}=fixture();
  try {
    const id=(await request('/api/salons')).data.shops[0].id;
    const a=await request(`/api/salons/${id}/tickets`,'POST',ticket());
    const b=await request(`/api/salons/${id}/tickets`,'POST',ticket());
    assert.equal(a.data.ticket.displayName,'손님1');assert.equal(b.data.ticket.displayName,'손님2');
    const input={...ticket('qr'),nickname:'  반짝손님  '};
    const nick=await request(`/api/salons/${id}/tickets`,'POST',input,null);
    assert.equal(nick.status,201);assert.equal(nick.data.ticket.displayName,'반짝손님');
    assert.equal((await request(`/api/salons/${id}/tickets`,'POST',{...input,nickname:'다른이름'},null)).status,409);
    assert.equal((await request(`/api/salons/${id}/tickets`,'POST',{...ticket('qr'),nickname:'가'.repeat(21)},null)).status,400);
    const publicShop=(await request(`/api/salons/${id}`,'GET',undefined,null)).data.shop;
    assert.equal(JSON.stringify(publicShop).includes('반짝손님'),false);
    assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',{action:'profile',name:'우리 이지헤어',subtitle:'동네에서 편안하게\n만나는 미용실'})).status,200);
    const page=(await request(`/api/salons/${id}`,'GET',undefined,null)).data.shop;
    assert.equal(page.name,'우리 이지헤어');assert.equal(page.subtitle,'동네에서 편안하게\n만나는 미용실');
    assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',{action:'profile',name:'변조',subtitle:''},'owner-b')).status,403);
  } finally {sqlite.close();}
});

test('loyalty enrollment earns once at completion and never merges identical nicknames', async () => {
  const {sqlite,request,ticket}=fixture();
  try {
    const id=(await request('/api/salons')).data.shops[0].id;
    assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',{action:'loyalty',enabled:true,target:2,benefit:'두 번 방문 혜택'})).status,200);
    const first={...ticket('qr'),nickname:'동네친구',loyaltyJoin:true};
    const joined=await request(`/api/salons/${id}/tickets`,'POST',first,null);
    assert.equal(joined.status,201);assert.ok(joined.data.membership.token);
    const token=joined.data.membership.token;
    assert.match(joined.data.membership.cardCode,/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    const replay=await request(`/api/salons/${id}/tickets`,'POST',first,null);
    assert.equal(replay.data.membership.token,token);
    let card=(await request('/api/members/'+token,'GET',undefined,null)).data;
    assert.equal(card.member.stamps,0);
    async function complete(receiptToken:string){
      const t=(await request(`/api/salons/${id}/owner`)).data.tickets.find(x=>x.token===receiptToken)!;
      for(const action of ['approve','start','complete'])assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',{action,ticketId:t.id})).status,200);
      assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',{action:'complete',ticketId:t.id})).status,200);
    }
    await complete(joined.data.ticket.token);
    card=(await request('/api/members/'+token,'GET',undefined,null)).data;
    assert.equal(card.member.stamps,1);assert.equal(card.member.lifetimeVisits,1);
    const second=await request(`/api/salons/${id}/tickets`,'POST',{...ticket('qr'),nickname:'동네친구',loyaltyJoin:true,memberToken:token},null);
    await complete(second.data.ticket.token);
    card=(await request('/api/members/'+token,'GET',undefined,null)).data;
    assert.equal(card.member.stamps,2);assert.equal(card.member.lifetimeVisits,2);
    const duplicateName=await request(`/api/salons/${id}/tickets`,'POST',{...ticket('qr'),nickname:'동네친구',loyaltyJoin:true},null);
    assert.notEqual(duplicateName.data.membership.token,token);
    assert.equal((await request('/api/members/'+duplicateName.data.membership.token,'GET',undefined,null)).data.member.stamps,0);
    const own=(await request(`/api/salons/${id}/owner`)).data;
    assert.equal(own.members.length,2);assert.equal(JSON.stringify(own).includes(token),false);assert.equal(new Set(own.members.map(m=>m.cardCode)).size,2);assert.equal(own.members.find(m=>m.stamps===2)?.cardCode,card.member.cardCode);
    const member=own.members.find(m=>m.stamps===2)!;
    const redemption={action:'redeem',memberId:member.id,requestId:crypto.randomUUID()};
    assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',redemption)).status,200);
    assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',redemption)).status,200);
    card=(await request('/api/members/'+token,'GET',undefined,null)).data;
    assert.equal(card.member.stamps,0);assert.equal(card.member.lifetimeVisits,2);
    assert.equal(card.history.filter(h=>h.kind==='redeem').length,1);
    assert.equal((await request(`/api/salons/${id}/owner`,'PATCH',{...redemption,requestId:crypto.randomUUID()})).status,409);
  } finally {sqlite.close();}
});

test('member capabilities cannot enroll across salons or bypass reward permissions', async () => {
  const {sqlite,request,ticket}=fixture();
  try {
    const a=(await request('/api/salons')).data.shops[0].id;
    const b=(await request('/api/salons','GET',undefined,'owner-b')).data.shops[0].id;
    for(const [id,user] of [[a,'owner-a'],[b,'owner-b']])await request(`/api/salons/${id}/owner`,'PATCH',{action:'loyalty',enabled:true,target:2,benefit:'방문 혜택'},user);
    const joined=await request(`/api/salons/${a}/tickets`,'POST',{...ticket('qr'),nickname:'한웅',loyaltyJoin:true},null);
    const token=joined.data.membership.token;
    assert.equal((await request(`/api/salons/${b}/tickets`,'POST',{...ticket('qr'),nickname:'한웅',loyaltyJoin:true,memberToken:token},null)).status,404);
    assert.equal((await request('/api/members/'+crypto.randomUUID()+crypto.randomUUID(),'GET',undefined,null)).status,404);
    assert.equal((await request('/api/members/by-name?nickname=한웅','GET',undefined,null)).status,404);
    const member=(await request(`/api/salons/${a}/owner`)).data.members[0];
    assert.equal((await request(`/api/salons/${a}/owner`,'PATCH',{action:'redeem',memberId:member.id,requestId:crypto.randomUUID()},'owner-b')).status,403);
    assert.equal((await request(`/api/salons/${a}/tickets`,'POST',{...ticket(),nickname:'한웅',loyaltyJoin:true})).status,400);
    await request(`/api/salons/${a}/owner`,'PATCH',{action:'loyalty',enabled:false,target:2,benefit:'방문 혜택'});
    assert.equal((await request(`/api/salons/${a}/tickets`,'POST',{...ticket('qr'),nickname:'신규',loyaltyJoin:true},null)).status,409);
    assert.equal((await request('/api/members/'+token,'GET',undefined,null)).data.member.stamps,0);
  } finally {sqlite.close();}
});

test('reservation APIs isolate contact details and enforce salon-scoped owner settings',async()=>{
 const {sqlite,request}=fixture();try{
 const id=(await request('/api/salons')).data.shops[0].id;
 const endpoint=`/api/salons/${id}/reservations`;
 const settings={action:'settings',enabled:true,weekdays:[0,1,2,3,4,5,6],startTime:'10:00',endTime:'19:00',interval:30,noticeMinutes:0};
 assert.equal((await request(endpoint,'PATCH',settings,'owner-b')).status,403);
 assert.equal((await request(endpoint+'?manage=1','GET',undefined,null)).status,401);
 assert.equal((await request(endpoint+'?manage=1','GET',undefined,'owner-b')).status,403);
 assert.equal((await request(endpoint,'PATCH',settings)).status,200);
 const date=new Date(Date.now()+9*3600000+86400000).toISOString().slice(0,10);
 const startsAt=Date.parse(date+'T10:00:00+09:00');
 const req={requestId:crypto.randomUUID(),realName:'예약실명',phone:'010-4567-8910',privacyConsent:true,serviceIds:['mens-cut'],startsAt};
 const created=await request(endpoint,'POST',req,null);assert.equal(created.status,201);
 const data=created.data as unknown as {reservation:{token:string;phoneMasked:string}};
 const token=data.reservation.token;assert.equal(data.reservation.phoneMasked,'010-****-8910');
 const pub=await request(endpoint+`?date=${date}&serviceId=mens-cut`,'GET',undefined,null);
 assert.equal(pub.status,200);assert.ok(!JSON.stringify(pub.data).includes('예약실명'));assert.ok(!JSON.stringify(pub.data).includes('4567'));assert.ok(!JSON.stringify(pub.data).includes(token));
 const owner=await request(endpoint+'?manage=1');assert.match(JSON.stringify(owner.data),/01045678910/);assert.ok(!JSON.stringify(owner.data).includes(token));
 assert.ok(!JSON.stringify((await request(`/api/salons/${id}`,'GET',undefined,null)).data).includes('예약실명'));
 assert.equal((await request('/api/reservations/not-a-token','GET',undefined,null)).status,404);
 assert.equal((await request('/api/reservations/'+token,'GET',undefined,null)).status,200);
 assert.equal((await request(endpoint,'POST',req,null)).status,201);
 assert.equal((await request(endpoint,'POST',{...req,realName:'다른사람'},null)).status,409);
 assert.equal((await request('/api/reservations/'+token,'PATCH',{action:'checkIn'},null)).status,400);
 assert.equal((await request('/api/reservations/'+token,'PATCH',{action:'cancel'},null)).status,200);
 assert.equal((await request(endpoint,'POST',{...req,requestId:crypto.randomUUID()},null)).status,201);
 }finally{sqlite.close();}
});

test('SQL CAS admits exactly one simultaneous reservation per occupied service interval',async()=>{
 const {sqlite,request}=fixture();try{
 const id=(await request('/api/salons')).data.shops[0].id,endpoint=`/api/salons/${id}/reservations`;
 await request(endpoint,'PATCH',{action:'settings',enabled:true,weekdays:[0,1,2,3,4,5,6],startTime:'10:00',endTime:'19:00',interval:30,noticeMinutes:0});
 const date=new Date(Date.now()+9*3600000+86400000).toISOString().slice(0,10);
 const req={requestId:crypto.randomUUID(),realName:'홍길동',phone:'01012345678',privacyConsent:true,serviceIds:['color'],startsAt:Date.parse(date+'T10:00:00+09:00')};
 const results=await Promise.all([request(endpoint,'POST',req,null),request(endpoint,'POST',{...req,requestId:crypto.randomUUID(),startsAt:req.startsAt+30*60000},null)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 const stored=JSON.parse(String(sqlite.prepare('SELECT state FROM shops WHERE id=?').get(id)!.state));assert.equal(stored.reservations.length,1);
 }finally{sqlite.close();}
});

test('scheduler policies and opinions are owner-scoped, preview is read-only, and parallel slots use SQL CAS',async()=>{
 const {sqlite,request}=fixture();try{
 const id=(await request('/api/salons')).data.shops[0].id,endpoint=`/api/salons/${id}/scheduler`;
 assert.equal((await request(endpoint,'GET',undefined,null)).status,401);
 assert.equal((await request(endpoint,'GET',undefined,'owner-b')).status,403);
 assert.equal((await request(endpoint,'PATCH',{action:'analyze'},'owner-b')).status,403);
 const initial=(await request(endpoint)).data as unknown as {scheduler:import('../lib/scheduler.ts').SchedulerState;aiAvailable:boolean};assert.equal(initial.aiAvailable,false);
 const profile=initial.scheduler.draft;profile.staff[0].weekdays=[0,1,2,3,4,5,6];profile.staff.push({...structuredClone(profile.staff[0]),id:'worker-two',label:'직원 2'});
 assert.equal((await request(endpoint,'PATCH',{action:'activate',profile,expectedVersion:0})).status,200);
 assert.equal((await request(endpoint,'PATCH',{action:'activate',profile,expectedVersion:0})).status,409);
 assert.equal((await request(endpoint,'POST',{action:'interview',interview:'두 명 근무'})).status,503);
 const bookingPath=`/api/salons/${id}/reservations`;
 await request(bookingPath,'PATCH',{action:'settings',enabled:true,weekdays:[0,1,2,3,4,5,6],startTime:'10:00',endTime:'19:00',interval:30,noticeMinutes:0});
 const date=new Date(Date.now()+9*3600000+86400000).toISOString().slice(0,10),startsAt=Date.parse(date+'T10:00:00+09:00');
 const before=sqlite.prepare('SELECT revision FROM shops WHERE id=?').get(id)!.revision;
 assert.equal((await request(endpoint,'POST',{action:'preview',profile,date,serviceIds:['mens-cut']})).status,200);
 assert.equal(sqlite.prepare('SELECT revision FROM shops WHERE id=?').get(id)!.revision,before);
 const responses=await Promise.all(Array.from({length:3},()=>request(bookingPath,'POST',{requestId:crypto.randomUUID(),realName:'병렬예약',phone:'01012345678',privacyConsent:true,startsAt,serviceIds:['mens-cut']},null)));
 assert.deepEqual(responses.map(r=>r.status).sort(),[201,201,409]);
 const stored=JSON.parse(String(sqlite.prepare('SELECT state FROM shops WHERE id=?').get(id)!.state));assert.equal(new Set(stored.reservations.map((r:{allocation:{staffId:string}})=>r.allocation.staffId)).size,2);
 assert.ok(!JSON.stringify((await request(`/api/salons/${id}`,'GET',undefined,null)).data).includes('staff'));
 }finally{sqlite.close();}
});

test('AI interview call is mocked, stores draft only, and enforces per-shop cooldown',async()=>{
 let calls=0;const profile=(await import('../lib/scheduler.ts')).initialProfile(makeShop('owner'));
 const fake=(async()=>{calls++;return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({profile,summary:'초안입니다',questions:[]})}]}]});}) as typeof fetch;
 const {sqlite,request}=fixture({masterUserIds:[],schedulerAI:{key:'never-output-test-key',model:'test-model',fetcher:fake}});try{
 const id=(await request('/api/salons')).data.shops[0].id,endpoint=`/api/salons/${id}/scheduler`;
 const result=await request(endpoint,'POST',{action:'interview',interview:'직원 한 명이 근무해요.'});assert.equal(result.status,200);assert.equal(calls,1);
 const state=JSON.parse(String(sqlite.prepare('SELECT state FROM shops WHERE id=?').get(id)!.state)).scheduler;assert.equal(state.active,undefined);assert.equal(state.version,0);
 assert.equal((await request(endpoint,'POST',{action:'interview',interview:'다시 분석해요.'})).status,429);assert.equal(calls,1);
 assert.ok(!JSON.stringify(result.data).includes('never-output-test-key'));
 }finally{sqlite.close();}
});
