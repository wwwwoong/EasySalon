import {DomainError,type Shop} from './domain.ts';
export type Stage={name:string;minutes:number;needsStaff:boolean;resource:'chair'|'wash'|'none'};
export type SchedulerProfile={enabled:boolean;chairs:number;washBasins:number;bufferMinutes:number;staff:{id:string;label:string;serviceIds:string[];weekdays:number[];startTime:string;endTime:string}[];services:{serviceId:string;stages:Stage[]}[];notes:string};
export type Allocation={staffId:string;staffLabel:string;version:number;stages:{name:string;start:number;end:number;staffId?:string;resource:Stage['resource']}[]};
export type Feedback={id:string;serviceId:string;stageIndex:number;kind:'tight'|'late'|'idle'|'good';actualMinutes?:number;note:string;at:number;version:number};
export type Proposal={id:string;baseVersion:number;profile:SchedulerProfile;reason:string;source:'records'|'ai';status:'pending'|'applied'|'rejected';at:number};
export type SchedulerState={version:number;active?:SchedulerProfile;draft:SchedulerProfile;history:{version:number;profile:SchedulerProfile;at:number;reason:string}[];feedback:Feedback[];proposals:Proposal[];interview:string;questions:string[];aiRequestedAt?:number};
export function initialProfile(shop:Shop):SchedulerProfile{return {enabled:true,chairs:2,washBasins:1,bufferMinutes:5,staff:[{id:crypto.randomUUID(),label:'직원 1',serviceIds:shop.menu.map(s=>s.id),weekdays:[1,2,3,4,5],startTime:'10:00',endTime:'19:00'}],services:shop.menu.map(s=>({serviceId:s.id,stages:[{name:'시술',minutes:s.duration,needsStaff:true,resource:'chair'}]})),notes:''};}
export function schedulerState(shop:Shop):SchedulerState{return structuredClone(shop.state.scheduler??{version:0,draft:initialProfile(shop),history:[],feedback:[],proposals:[],interview:'',questions:[]});}
const text=(v:unknown,n:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=n&&!/[\x00-\x1f\x7f]/.test(v);
const integer=(v:unknown,min:number,max:number)=>typeof v==='number'&&Number.isInteger(v)&&v>=min&&v<=max;
const clock=(v:unknown)=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
function clockMinutes(v:string){return Number(v.slice(0,2))*60+Number(v.slice(3));}
export function validateProfile(value:unknown,shop:Shop):SchedulerProfile{
 if(!value||typeof value!=='object')throw new DomainError('운영 인터뷰 설정을 확인해 주세요.');const p=value as SchedulerProfile;
 if(typeof p.enabled!=='boolean'||!integer(p.chairs,1,20)||!integer(p.washBasins,0,10)||!integer(p.bufferMinutes,0,60)||!Array.isArray(p.staff)||p.staff.length<1||p.staff.length>6||!Array.isArray(p.services)||p.services.length>30||typeof p.notes!=='string'||p.notes.length>2000)throw new DomainError('인력·시설·여유 시간을 확인해 주세요.');
 const staffIds=new Set<string>();for(const s of p.staff){if(!s||!text(s.id,80)||staffIds.has(s.id)||!text(s.label,30)||!Array.isArray(s.serviceIds)||!s.serviceIds.length||new Set(s.serviceIds).size!==s.serviceIds.length||s.serviceIds.some(id=>!shop.menu.some(m=>m.id===id))||!Array.isArray(s.weekdays)||!s.weekdays.length||new Set(s.weekdays).size!==s.weekdays.length||s.weekdays.some(n=>!integer(n,0,6))||!clock(s.startTime)||!clock(s.endTime)||clockMinutes(s.startTime)>=clockMinutes(s.endTime))throw new DomainError('직원별 가능 시술·근무 요일·시간을 확인해 주세요.');staffIds.add(s.id);}
 const serviceIds=new Set<string>();for(const s of p.services){if(!s||!shop.menu.some(m=>m.id===s.serviceId)||serviceIds.has(s.serviceId)||!Array.isArray(s.stages)||s.stages.length<1||s.stages.length>8)throw new DomainError('메뉴별 시술 단계를 확인해 주세요.');serviceIds.add(s.serviceId);for(const stage of s.stages){if(!stage||!text(stage.name,40)||!integer(stage.minutes,1,300)||typeof stage.needsStaff!=='boolean'||!['chair','wash','none'].includes(stage.resource))throw new DomainError('단계별 시간과 자원을 확인해 주세요.');if(stage.resource==='wash'&&!p.washBasins)throw new DomainError('샴푸대가 없는 설정에서는 샴푸 단계를 사용할 수 없습니다.');}if(!s.stages.some(t=>t.needsStaff)||s.stages.reduce((n,t)=>n+t.minutes,0)>600)throw new DomainError('시술에는 담당자 작업 단계가 필요하며 전체는 600분 이내여야 합니다.');}
 if(p.enabled&&shop.menu.some(m=>!serviceIds.has(m.id)))throw new DomainError('모든 현재 메뉴의 시술 단계를 등록해 주세요.');
 return structuredClone({enabled:p.enabled,chairs:p.chairs,washBasins:p.washBasins,bufferMinutes:p.bufferMinutes,staff:p.staff.map(s=>({id:s.id,label:s.label.trim(),serviceIds:[...s.serviceIds],weekdays:[...s.weekdays].sort(),startTime:s.startTime,endTime:s.endTime})),services:p.services,notes:p.notes});
}
export function selectedStages(profile:SchedulerProfile,ids:string[]){return ids.flatMap(id=>{const s=profile.services.find(s=>s.serviceId===id);if(!s)throw new DomainError('메뉴의 단계별 운영 설정이 필요합니다.',409);return s.stages;});}
function blocks(profile:SchedulerProfile,ids:string[],start:number,staffId:string){let cursor=start;const result:Allocation['stages']=selectedStages(profile,ids).map(s=>{const item={name:s.name,start:cursor,end:cursor+s.minutes*60000,staffId:s.needsStaff?staffId:undefined,resource:s.resource};cursor=item.end;return item;});if(profile.bufferMinutes)result.push({name:'정리·여유',start:cursor,end:cursor+profile.bufferMinutes*60000,staffId,resource:'chair'});return result;}
function peak(windows:{start:number;end:number}[]){const events=windows.flatMap(w=>[{at:w.start,delta:1},{at:w.end,delta:-1}]).sort((a,b)=>a.at-b.at||a.delta-b.delta);let count=0,max=0;for(const event of events){count+=event.delta;max=Math.max(max,count);}return max;}
export function allocationFor(shop:Shop,profile:SchedulerProfile,ids:string[],start:number,version:number):Allocation|null{
 const offsetDate=new Date(start+9*3600000),weekday=offsetDate.getUTCDay(),day=offsetDate.toISOString().slice(0,10),midnight=Date.parse(day+'T00:00:00+09:00');
 const reservations=(shop.state.reservations??[]).filter(r=>['booked','checkedIn'].includes(r.status));
 for(const staff of profile.staff){
 if(!staff.weekdays.includes(weekday)||!ids.every(id=>staff.serviceIds.includes(id)))continue;
 const candidate=blocks(profile,ids,start,staff.id),end=candidate.at(-1)!.end;
 if(start<midnight+clockMinutes(staff.startTime)*60000||end>midnight+clockMinutes(staff.endTime)*60000)continue;
 // Reservations made before stage scheduling keep an exclusive full interval.
 if(reservations.some(r=>!r.allocation&&r.startsAt<end&&r.endsAt>start))continue;
 const occupied=reservations.flatMap(r=>r.allocation?.stages??[]).filter(b=>b.start<end&&b.end>start);
 if(candidate.some(c=>c.staffId&&occupied.some(b=>b.staffId===c.staffId&&b.start<c.end&&b.end>c.start)))continue;
 if((['chair','wash'] as const).some(resource=>peak([...occupied,...candidate].filter(b=>b.resource===resource))>(resource==='chair'?profile.chairs:profile.washBasins)))continue;
 return {staffId:staff.id,staffLabel:staff.label,version,stages:candidate};
 }
 return null;
}
export function assertExistingFits(shop:Shop,profile:SchedulerProfile,now=Date.now()){
 const reservations=(shop.state.reservations??[]).filter(r=>['booked','checkedIn'].includes(r.status)&&r.endsAt>now&&r.allocation);
 if(!profile.enabled&&reservations.length)throw new DomainError('단계별 설정으로 확정한 예정 예약이 있어 단일 예약 방식으로 전환할 수 없습니다.',409);
 for(const r of reservations){const a=r.allocation!,staff=profile.staff.find(s=>s.id===a.staffId),day=new Date(r.startsAt+9*3600000),midnight=Date.parse(day.toISOString().slice(0,10)+'T00:00:00+09:00');if(!staff||!staff.weekdays.includes(day.getUTCDay())||(r.serviceIds??[]).some(id=>!staff.serviceIds.includes(id))||r.startsAt<midnight+clockMinutes(staff.startTime)*60000||r.endsAt>midnight+clockMinutes(staff.endTime)*60000)throw new DomainError('이미 확정된 예약의 담당자·근무 시간과 충돌합니다. 기존 예약을 먼저 확인해 주세요.',409);}
 const occupied=reservations.flatMap(r=>r.allocation!.stages);for(const resource of ['chair','wash'] as const)if(peak(occupied.filter(b=>b.resource===resource))>(resource==='chair'?profile.chairs:profile.washBasins))throw new DomainError('이미 확정된 예약에 필요한 시설 수보다 적습니다.',409);
}
function activate(shop:Shop,state:SchedulerState,profile:SchedulerProfile,reason:string,now:number){const checked=validateProfile(profile,shop);assertExistingFits(shop,checked,now);if(state.active)state.history.push({version:state.version,profile:state.active,at:now,reason});state.history=state.history.slice(-10);state.version++;state.active=checked;state.draft=structuredClone(checked);shop.state.scheduler=state;}
export function schedulerCommand(shop:Shop,input:Record<string,unknown>,now=Date.now()){
 const state=schedulerState(shop),action=input.action;
 if(action==='draft'){state.draft=validateProfile(input.profile,shop);if(typeof input.interview!=='string'||input.interview.length>6000)throw new DomainError('인터뷰 답변은 6000자 이내로 입력해 주세요.');state.interview=input.interview;shop.state.scheduler=state;return;}
 if(action==='activate'||action==='restore'||action==='apply'){
 if(input.expectedVersion!==state.version)throw new DomainError('운영 설정이 변경되었습니다. 새로고침 후 다시 확인해 주세요.',409);
 if(action==='activate'){activate(shop,state,validateProfile(input.profile,shop),'사장님 운영표 적용',now);return;}
 if(action==='restore'){const history=state.history.find(h=>h.version===input.version);if(!history)throw new DomainError('복원할 설정을 찾을 수 없습니다.',404);activate(shop,state,history.profile,'이전 운영표 복원',now);return;}
 const proposal=state.proposals.find(p=>p.id===input.proposalId);if(!proposal||proposal.status!=='pending'||proposal.baseVersion!==state.version)throw new DomainError('이미 처리되었거나 현재 설정과 다른 제안입니다.',409);proposal.status='applied';activate(shop,state,proposal.profile,proposal.reason,now);return;
 }
 if(action==='reject'){const p=state.proposals.find(p=>p.id===input.proposalId);if(!p)throw new DomainError('제안을 찾을 수 없습니다.',404);if(p.status!=='pending')throw new DomainError('이미 처리한 제안입니다.',409);p.status='rejected';shop.state.scheduler=state;return;}
 if(action==='feedback'){
 if(!state.active)throw new DomainError('운영 인터뷰 설정을 먼저 적용해 주세요.',409);
 const service=state.active.services.find(s=>s.serviceId===input.serviceId);if(!service||!integer(input.stageIndex,0,service.stages.length-1)||!['tight','late','idle','good'].includes(String(input.kind))||typeof input.note!=='string'||input.note.length>500||input.actualMinutes!==undefined&&!integer(input.actualMinutes,1,300))throw new DomainError('의견의 시술·단계·실제 시간을 확인해 주세요.');
 if(typeof input.requestId!=='string'||! /^[0-9a-f-]{36}$/i.test(input.requestId))throw new DomainError('의견 요청을 확인해 주세요.');
 const prior=state.feedback.find(f=>f.id===input.requestId);if(prior){if(prior.serviceId!==input.serviceId||prior.stageIndex!==input.stageIndex||prior.kind!==input.kind||prior.actualMinutes!==input.actualMinutes||prior.note!==input.note)throw new DomainError('같은 의견 요청의 내용이 다릅니다.',409);return;}
 state.feedback.push({id:input.requestId,serviceId:input.serviceId as string,stageIndex:input.stageIndex as number,kind:input.kind as Feedback['kind'],actualMinutes:input.actualMinutes as number|undefined,note:input.note,at:now,version:state.version});state.feedback=state.feedback.slice(-500);shop.state.scheduler=state;return;
 }
 if(action==='analyze'){
 if(!state.active)throw new DomainError('운영표를 먼저 적용해 주세요.',409);
 const previous=state.proposals.find(p=>p.baseVersion===state.version&&p.status==='pending');if(previous)return;
 const profile=structuredClone(state.active),reasons:string[]=[];
 for(const service of profile.services)service.stages.forEach((stage,index)=>{const samples=state.feedback.filter(f=>f.version===state.version&&f.serviceId===service.serviceId&&f.stageIndex===index&&f.actualMinutes!==undefined);if(samples.length<3)return;const sorted=samples.map(s=>s.actualMinutes!).sort((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)];if(median>stage.minutes&&samples.filter(s=>['late','tight'].includes(s.kind)).length>=2){const before=stage.minutes;stage.minutes=Math.min(300,stage.minutes+5,median);reasons.push(`${shop.menu.find(m=>m.id===service.serviceId)?.name??'시술'} · ${stage.name}: ${samples.length}건, 중앙값 ${median}분 → ${before}분에서 ${stage.minutes}분 제안`);}});
 if(!reasons.length)throw new DomainError('같은 운영 버전·시술 단계의 실제 시간 기록이 3건 이상이며, 빠듯함·지연 의견이 2건 이상일 때 시간 증가를 제안합니다. 아직 근거가 부족합니다.',409);
 validateProfile(profile,shop);state.proposals.push({id:crypto.randomUUID(),baseVersion:state.version,profile,reason:reasons.join('\n'),source:'records',status:'pending',at:now});state.proposals=state.proposals.slice(-30);shop.state.scheduler=state;return;
 }
 throw new DomainError('스케줄러 작업을 확인해 주세요.');
}
