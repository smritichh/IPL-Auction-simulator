// Standalone harness to tune the auction valuation engine before porting to JSX.
// Run: node data/sim_test.mjs
import { PLAYERS } from "../ipl-app/src/players.js";

const TEAMS = [
  { id: "MI", agg: 1.0 }, { id: "CSK", agg: 1.0 }, { id: "RCB", agg: 1.12 },
  { id: "KKR", agg: 0.98 }, { id: "DC", agg: 0.92 }, { id: "SRH", agg: 1.08 },
  { id: "RR", agg: 0.90 }, { id: "PBKS", agg: 1.10 }, { id: "GT", agg: 1.0 },
  { id: "LSG", agg: 1.03 },
];

// ---- engine constants ----
const SQUAD_TARGET = 21, SQUAD_MIN = 18, MAX_SQUAD = 25, OVERSEAS_MAX = 8, FLOOR = 0.4;
const CAT_TARGET = { topBat:3, midBat:3, finisher:2, wk:2, pace:4, spin:3, deathBowl:2, powerplay:3, allrounder:3 };

const round2 = (v) => Math.round(v*100)/100;
const inc = (p) => (p < 5 ? 0.5 : p < 12 ? 1.0 : 2.0);

function playerCats(p){
  const c=[];
  if(p.batOrder==="top")c.push("topBat"); else if(p.batOrder==="mid")c.push("midBat");
  if(p.finisher)c.push("finisher");
  if(p.wk)c.push("wk");
  if(p.bowlType==="pace")c.push("pace");
  if(p.bowlType==="spin")c.push("spin");
  if(p.deathSpec)c.push("deathBowl");
  if(p.bowlType&&(p.bowlPhase==="pp"||p.bowlPhase==="mid"))c.push("powerplay");
  if(p.role==="All-rounder")c.push("allrounder");
  return c;
}
function squadCatCounts(squad){
  const c={}; for(const s of squad) for(const k of playerCats(s)) c[k]=(c[k]||0)+1; return c;
}
const overseasCount = (squad)=>squad.filter(s=>s.overseas).length;

function needMult(p, squad, bias){
  const counts=squadCatCounts(squad);
  let def = playerCats(p).map(k=>{
    const t=CAT_TARGET[k]||2, have=counts[k]||0;
    return Math.max(0,(t-have)/t) * (bias?.[k]??1);
  });
  if(!def.length) def=[0.25];
  def.sort((a,b)=>b-a);
  const d=Math.min(1.3, def[0] + (def[1]||0)*0.35);
  return 0.3 + d*1.0;        // ~0.3 .. ~1.6
}
const ratingMult = (p)=>0.6 + Math.max(0,Math.min(50,(p.rating||60)-45))/50*2.4; // 0.6..3.0

function valuation(team, p, v, lotsLeft, activeNeeders, bias){
  const n = team.squad.length;
  if(n>=MAX_SQUAD) return 0;
  if(p.overseas && overseasCount(team.squad)>=OVERSEAS_MAX) return 0;
  const slotsNeeded = Math.max(0, SQUAD_TARGET - n);
  // hoarding falloff: once at/above target, sharply reduce willingness so
  // trailing teams can catch up and nobody runs away to 24-25 players.
  const glut = n>=23 ? 0.12 : n>=SQUAD_TARGET ? 0.4 : 1;
  const effSlots = Math.max(1, slotsNeeded);
  const effectiveFloor = Math.min(FLOOR, (team.purse / effSlots) * 0.5);
  const reserveOthers = Math.max(0, effSlots-1)*effectiveFloor;
  const maxAfford = Math.max(0, team.purse - reserveOthers);
  if(maxAfford <= 0) return 0;
  const avgPerSlot = team.purse / effSlots;
  const nm = needMult(p, team.squad, bias);
  // Keeper guarantee (mirrors IplAuctionScreen.jsx): a keeperless team's keeper
  // appetite ramps up as the auction runs down, staying within the discipline
  // cap early so it never overpays for a marquee keeper.
  const needKeeper = p.wk && !team.squad.some((s) => s.wk);
  const keeperBoost = needKeeper ? Math.min(3, Math.max(0, (180 - lotsLeft) / 60)) : 0;
  const myShare = lotsLeft / Math.max(1, activeNeeders);
  const pressure = slotsNeeded / Math.max(0.5, myShare);
  const minDeficit = Math.max(0, SQUAD_MIN - n);
  const desperation = minDeficit>0 ? minDeficit * 0.18 / Math.max(0.4, myShare) : 0;
  const brokeAndNeedy = avgPerSlot < 2.0 && minDeficit > 3;
  const criticalBoost = brokeAndNeedy
    ? Math.min(2.0, ((2.0 - avgPerSlot) / 2.0) * 3.0 * Math.min(1, minDeficit / 5))
    : 0;
  const urgency = 1 + Math.max(0, pressure - 1.0)*1.2 + desperation + criticalBoost;
  const desire = Math.max(p.base, v*nm);
  // Premium players (80+) draw bidding wars toward their per-game market value
  // (mirrors IplAuctionScreen.jsx) so stars vary in price; sub-80 unchanged.
  const warCap    = avgPerSlot * ratingMult(p) * urgency;
  const starW     = Math.max(0, Math.min(1, (p.rating - 80) / 15));
  const demandCap = Math.min(v * 1.05, team.purse * 0.4);
  const disciplineCap = warCap + starW * Math.max(0, demandCap - warCap);
  const floorWill = Math.max(0, urgency - 1) * warCap;
  return Math.min(Math.max(desire, floorWill), disciplineCap, maxAfford, team.purse) * glut;
}

function makeBias(){
  const keys=Object.keys(CAT_TARGET), b={};
  for(const k of keys) b[k]=0.8 + Math.random()*0.5; // 0.8..1.3
  return b;
}

// market value per team (mirrors vals useMemo)
function buildVals(){
  return PLAYERS.map(p=>{
    const noise={Marquee:.26,Star:.32,Established:.38,Emerging:.46,Uncapped:.55}[p.tier]??.4;
    const shuffled=[...TEAMS].sort(()=>Math.random()-.5);
    const hot=new Set(shuffled.slice(0,2).map(t=>t.id));
    const row={};
    TEAMS.forEach(t=>{
      const hunger=hot.has(t.id)?(1.2+Math.random()*0.15):1.0;
      row[t.id]=round2(p.mv*t.agg*hunger*(1+(Math.random()*2-1)*noise));
    });
    return row;
  });
}

function runAuction(){
  const vals=buildVals();
  const teams=TEAMS.map(t=>({...t, purse:120, squad:[], bias:makeBias()}));
  for(let idx=0; idx<PLAYERS.length; idx++){
    const p=PLAYERS[idx];
    const lotsLeft=PLAYERS.length-idx;
    const activeNeeders=teams.filter(t=>t.squad.length<SQUAD_TARGET).length;
    let leader=null, bid=null, asking=p.base;
    for(let i=0;i<400;i++){
      const cand=teams.filter(t=>t.id!==leader && t.squad.length<MAX_SQUAD && t.purse>=asking);
      const willing=cand.filter(t=>valuation(t,p,vals[idx][t.id],lotsLeft,activeNeeders,t.bias)>=asking);
      if(!willing.length) break;
      willing.sort((a,b)=>valuation(b,p,vals[idx][b.id],lotsLeft,activeNeeders,b.bias)-valuation(a,p,vals[idx][a.id],lotsLeft,activeNeeders,a.bias));
      const top=willing.slice(0,Math.min(3,willing.length));
      const actor=top[Math.floor(Math.random()*top.length)];
      const wa=valuation(actor,p,vals[idx][actor.id],lotsLeft,activeNeeders,actor.bias);
      let nb=asking;
      if(Math.random()<0.25 && wa>=asking+inc(asking)*2) nb=round2(asking+inc(asking));
      nb=round2(Math.min(nb,wa,actor.purse));
      leader=actor.id; bid=nb; asking=round2(nb+inc(nb));
    }
    if(leader){
      const t=teams.find(t=>t.id===leader);
      t.purse=round2(t.purse-bid); t.squad.push({...p,price:bid});
    }
  }
  return teams;
}

// run several times, report
console.log("RUN | team sizes (spent%) ...");
for(let r=0;r<5;r++){
  const teams=runAuction();
  const parts=teams.map(t=>`${t.id}:${t.squad.length}(${Math.round((120-t.purse)/120*100)}%)`);
  const sizes=teams.map(t=>t.squad.length);
  const sold=teams.reduce((a,t)=>a+t.squad.length,0);
  console.log(`#${r+1} sold=${sold}/${PLAYERS.length} min=${Math.min(...sizes)} max=${Math.max(...sizes)} | ${parts.join(" ")}`);
}
// detail one run: role/overseas balance + complementary check
const teams=runAuction();
console.log("\n=== sample squad balance (run 6) ===");
for(const t of teams){
  const cc=squadCatCounts(t.squad);
  const ov=overseasCount(t.squad);
  console.log(`${t.id.padEnd(4)} n=${t.squad.length} spent=${(120-t.purse).toFixed(1)} OS=${ov} | top:${cc.topBat||0} mid:${cc.midBat||0} fin:${cc.finisher||0} wk:${cc.wk||0} pace:${cc.pace||0} spin:${cc.spin||0} death:${cc.deathBowl||0} ar:${cc.allrounder||0}`);
}

// price sanity + keeper coverage across many runs
console.log("\n=== price sanity + keeper coverage (10 runs) ===");
let overallMax=0, topSale=null, keeperless=0, minKeepers=99;
for(let r=0;r<10;r++){
  const ts=runAuction();
  for(const t of ts){
    const wk=t.squad.filter(p=>p.wk).length;
    if(wk===0) keeperless++;
    minKeepers=Math.min(minKeepers, wk);
    for(const p of t.squad){ if(p.price>overallMax){ overallMax=p.price; topSale=`${p.name} ${p.price}Cr`; } }
  }
}
console.log(`most expensive sale across 10 runs: ${topSale} (real IPL record ~27Cr)`);
console.log(`teams that ended keeperless: ${keeperless}/100  | min keepers on any team: ${minKeepers}`);

// price variance for a few marquee names across 30 runs
console.log("\n=== marquee price spread (30 runs, AI-only) ===");
const watch = ["Virat Kohli","Jasprit Bumrah","Travis Head","Heinrich Klaasen"];
const seen = Object.fromEntries(watch.map(n=>[n,[]]));
for(let r=0;r<30;r++){
  const ts=runAuction();
  for(const t of ts) for(const p of t.squad) if(seen[p.name]) seen[p.name].push(p.price);
}
for(const n of watch){
  const a=seen[n].sort((x,y)=>x-y);
  if(!a.length){ console.log(`${n}: never sold?!`); continue; }
  const min=a[0], max=a[a.length-1], med=a[Math.floor(a.length/2)];
  console.log(`${n.padEnd(18)} sold ${a.length}x | min ${min} med ${med} max ${max} | all: ${a.join(",")}`);
}
