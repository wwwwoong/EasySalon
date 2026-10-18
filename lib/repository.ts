import { DomainError, makeShop, type Shop, validCapability } from './domain.ts';
type Row={id:string;owner_id:string;name:string;subtitle:string;menu:string;settings:string;state:string;revision:number;updated_at:number};
export function decode(row:Row):Shop{return {id:row.id,ownerId:row.owner_id,name:row.name,subtitle:row.subtitle,menu:JSON.parse(row.menu),settings:JSON.parse(row.settings),state:JSON.parse(row.state),revision:row.revision,updatedAt:row.updated_at};}
export async function findShop(db:D1Database,id:string){const row=await db.prepare('SELECT * FROM shops WHERE id = ?').bind(id).first<Row>();if(!row)throw new DomainError('매장을 찾을 수 없습니다.',404);return decode(row);}
export async function ownedShops(db:D1Database,owner:string){const rows=await db.prepare('SELECT id,name,subtitle FROM shops WHERE owner_id = ? ORDER BY id LIMIT 1').bind(owner).all<{id:string;name:string;subtitle:string}>();return rows.results;}
export async function insertShop(db:D1Database,shop:Shop,exclusiveOwner=false){
 if(exclusiveOwner){const write=await db.prepare('INSERT INTO shops (id,owner_id,name,subtitle,menu,settings,state,revision,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM shops WHERE owner_id=?)').bind(shop.id,shop.ownerId,shop.name,shop.subtitle,JSON.stringify(shop.menu),JSON.stringify(shop.settings),JSON.stringify(shop.state),shop.revision,shop.updatedAt,shop.ownerId).run();if(write.meta.changes!==1)throw new DomainError('이미 다른 매장을 담당하는 계정입니다.',409);return;}await db.prepare('INSERT OR IGNORE INTO shops (id,owner_id,name,subtitle,menu,settings,state,revision,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(shop.id,shop.ownerId,shop.name,shop.subtitle,JSON.stringify(shop.menu),JSON.stringify(shop.settings),JSON.stringify(shop.state),shop.revision,shop.updatedAt).run();}
export async function initialize(db:D1Database,owner:string,name='오브헤어'){
 const existing=await ownedShops(db,owner);if(existing.length)return existing;
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(owner)))).map(v=>v.toString(16).padStart(2,'0')).join('');
 const shop=makeShop(owner,name);shop.id=`demo-${hash}-1`;await insertShop(db,shop);
 return ownedShops(db,owner);
}
export async function mutate<T>(db:D1Database,id:string,change:(shop:Shop)=>T,exclusiveOwner=false):Promise<{shop:Shop;result:T}>{
 for(let attempt=0;attempt<5;attempt++){
 const shop=await findShop(db,id);const revision=shop.revision;const result=change(shop);shop.revision++;shop.updatedAt=Date.now();
 const sql='UPDATE shops SET owner_id=?,name=?,subtitle=?,menu=?,settings=?,state=?,revision=?,updated_at=? WHERE id=? AND revision=?'+(exclusiveOwner?' AND NOT EXISTS (SELECT 1 FROM shops other WHERE other.owner_id=? AND other.id<>?)':'');
 const bindings=[shop.ownerId,shop.name,shop.subtitle,JSON.stringify(shop.menu),JSON.stringify(shop.settings),JSON.stringify(shop.state),shop.revision,shop.updatedAt,id,revision];
 if(exclusiveOwner)bindings.push(shop.ownerId,id);
 const write=await db.prepare(sql).bind(...bindings).run();
 if(write.meta.changes===1)return {shop,result};
 }
 throw new DomainError('다른 변경이 진행 중입니다. 잠시 후 다시 시도해 주세요.',409);
}
export async function findByToken(db:D1Database,token:string){
 if(!/^[0-9a-f-]{72}$/i.test(token))throw new DomainError('접수 정보를 찾을 수 없습니다.',404);
 const row=await db.prepare("SELECT * FROM shops WHERE EXISTS (SELECT 1 FROM json_each(shops.state, '$.tickets') t WHERE json_extract(t.value, '$.token') = ?) LIMIT 1").bind(token).first<Row>();
 if(!row)throw new DomainError('접수 정보를 찾을 수 없습니다.',404);
 const shop=decode(row);return {shop,ticket:shop.state.tickets.find(t=>t.token===token)!};
}

export async function allShops(db:D1Database){const rows=await db.prepare('SELECT * FROM shops ORDER BY id').all<Row>();return rows.results.map(decode);}
export type PlatformSettings={brandName:string;accentColor:string;announcement:string;maintenance:boolean};
export const defaultPlatform:PlatformSettings={brandName:'이지 살롱',accentColor:'#355b46',announcement:'',maintenance:false};
export async function platformSettings(db:D1Database):Promise<PlatformSettings>{
 const row=await db.prepare("SELECT value FROM platform_settings WHERE key = 'platform'").first<{value:string}>();
 if(!row)return {...defaultPlatform};
 const stored=JSON.parse(row.value);const {brandingVersion,...settings}=stored;
 return {...defaultPlatform,...settings,...(!brandingVersion&&stored.brandName==='순서'?{brandName:'이지 살롱'}:{})};
}
export function validatePlatform(input:Record<string,unknown>):PlatformSettings{
 if(typeof input.brandName!=='string'||!input.brandName.trim()||input.brandName.length>40||typeof input.accentColor!=='string'||!/^#[0-9a-f]{6}$/i.test(input.accentColor)||typeof input.announcement!=='string'||input.announcement.length>500||typeof input.maintenance!=='boolean')throw new DomainError('시스템 설정을 확인해 주세요.');
 return {brandName:input.brandName.trim(),accentColor:input.accentColor,announcement:input.announcement,maintenance:input.maintenance};
}
export async function savePlatform(db:D1Database,settings:PlatformSettings){await db.prepare("INSERT INTO platform_settings (key,value) VALUES ('platform',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({...settings,brandingVersion:1})).run();}

export async function findMemberByToken(db:D1Database,token:string){
 if(!validCapability(token))throw new DomainError('적립 정보를 찾을 수 없습니다.',404);
 const row=await db.prepare("SELECT * FROM shops WHERE EXISTS (SELECT 1 FROM json_each(shops.state, '$.members') m WHERE json_extract(m.value, '$.token') = ?) LIMIT 1").bind(token).first<Row>();
 if(!row)throw new DomainError('적립 정보를 찾을 수 없습니다.',404);
 const shop=decode(row);return {shop,member:shop.state.members!.find(m=>m.token===token)!};
}

export async function findReservationByToken(db:D1Database,token:string){
 if(!validCapability(token))throw new DomainError('예약을 찾을 수 없습니다.',404);
 const row=await db.prepare("SELECT * FROM shops WHERE EXISTS (SELECT 1 FROM json_each(shops.state, '$.reservations') r WHERE json_extract(r.value, '$.token') = ?) LIMIT 1").bind(token).first<Row>();
 if(!row)throw new DomainError('예약을 찾을 수 없습니다.',404);
 const shop=decode(row);return {shop,reservation:shop.state.reservations!.find(r=>r.token===token)!};
}
