// Forecast values: m/s, kelvin, geopotential metres, Unix milliseconds.
const RAD=Math.PI/180,KT=1.943844492;
export function leg(a,b){
 const p=a.lat*RAD,q=b.lat*RAD,d=(b.lon-a.lon)*RAD;
 const h=Math.sin((q-p)/2)**2+Math.cos(p)*Math.cos(q)*Math.sin(d/2)**2;
 return {nm:6371000*2*Math.asin(Math.sqrt(Math.min(1,h)))/1852,bearing:(Math.atan2(Math.sin(d)*Math.cos(q),Math.cos(p)*Math.sin(q)-Math.sin(p)*Math.cos(q)*Math.cos(d))/RAD+360)%360};
}
export function between(a,b,f){
 const p=a.lat*RAD,l=a.lon*RAD,q=b.lat*RAD,m=b.lon*RAD;
 const x=[Math.cos(p)*Math.cos(l),Math.cos(p)*Math.sin(l),Math.sin(p)],y=[Math.cos(q)*Math.cos(m),Math.cos(q)*Math.sin(m),Math.sin(q)];
 const d=Math.acos(Math.max(-1,Math.min(1,x.reduce((s,v,i)=>s+v*y[i],0))));
 if(d>Math.PI-1e-5)throw Error('Birbirine zıt iki nokta arasına ara nokta ekleyin.');
 const A=d<1e-8?1-f:Math.sin((1-f)*d)/Math.sin(d),B=d<1e-8?f:Math.sin(f*d)/Math.sin(d),v=x.map((n,i)=>A*n+B*y[i]);
 return {lat:Math.atan2(v[2],Math.hypot(v[0],v[1]))/RAD,lon:Math.atan2(v[1],v[0])/RAD};
}
export function splitRoute(points){
 if(points.length<2)throw Error('Önce en az iki noktalı bir rota oluşturun.');
 const out=[];
 for(let i=1;i<points.length;i++){
  const dist=leg(points[i-1],points[i]).nm;if(dist<.001)continue;
  const n=Math.ceil(dist*1.852/40);
  if(out.length+n>120)throw Error('Bu yerel denemede en fazla 120 hesap bölümü kullanılabilir. Rotayı kısaltın veya gereksiz ara noktaları azaltın.');
  for(let j=0;j<n;j++){
   const a=between(points[i-1],points[i],j/n),b=between(points[i-1],points[i],(j+1)/n);
   out.push({...leg(a,b),point:between(a,b,.5),end:b,waypoint:i+1});
  }
 }
 if(!out.length)throw Error('Rotanın uzunluğu sıfır.');return out;
}
function timeValue(data,key,t){
 const ts=data?.ts,values=data?.[key];
 if(!Array.isArray(ts)||!Array.isArray(values)||ts.length!==values.length||!ts.length)throw Error('İrtifa tahmin verisinin biçimi desteklenmiyor.');
 if(t<ts[0]||t>ts[ts.length-1])throw Error('Kalkış veya geçiş saati mevcut tahmin aralığının dışında.');
 let i=ts.findIndex(v=>v>=t);if(i<0)i=ts.length-1;
 const valid=v=>typeof v==='number'&&Number.isFinite(v);
 if(!valid(values[i]))throw Error('Seçilen saatte irtifa tahmini eksik.');
 if(ts[i]===t||i===0)return values[i];
 if(!valid(values[i-1])||ts[i]<=ts[i-1])throw Error('Tahmin zaman serisi eksik veya sırasız.');
 return values[i-1]+(values[i]-values[i-1])*(t-ts[i-1])/(ts[i]-ts[i-1]);
}
export function windAt(payload,t,metres){
 const d=payload.sounding;if(!d)throw Error('Windy irtifa profili (sounding) döndürmedi. Yüzey rüzgârıyla hesap yapılmadı.');
 const ground=payload.header?.elevation;
 if(typeof ground==='number'&&metres<=ground)throw Error('Girilen uçuş irtifası rotanın bir bölümünde model arazisinin altında ya da araziyle aynı seviyede. İrtifayı artırın.');
 const levels=[];
 for(const key of Object.keys(d)){
  const match=key.match(/^gh-(\d+)h$/);if(!match)continue;
  const level=match[1]+'h';
  if(!d['wind-'+level]||!d['windDir-'+level]||!d['temp-'+level])continue;
  const h=timeValue(d,key,t),temp=timeValue(d,'temp-'+level,t);
  const forces=d['wind-'+level],directions=d['windDir-'+level];
  const component=axis=>forces.map((speed,i)=>typeof speed==='number'&&Number.isFinite(speed)&&speed>=0&&typeof directions[i]==='number'&&Number.isFinite(directions[i])?-speed*(axis==='u'?Math.sin(directions[i]*RAD):Math.cos(directions[i]*RAD)):null);
  const u=timeValue({ts:d.ts,value:component('u')},'value',t),v=timeValue({ts:d.ts,value:component('v')},'value',t);
  if(temp<150||temp>350)throw Error('Tahmin birimleri veya değerleri beklenen aralıkta değil.');
  if(typeof ground==='number'&&h<ground)continue;
  levels.push({h,p:Number(match[1])*100,temp,u,v});
 }
 levels.sort((a,b)=>a.h-b.h);
 const hi=levels.findIndex(v=>v.h>=metres);
 if(hi<0||(!hi&&levels[0]?.h!==metres))throw Error('Bu irtifa mevcut basınç seviyelerinin dışında. Daha yüksek/düşük bir irtifa deneyin.');
 if(levels[hi].h===metres)return levels[hi];
 const a=levels[hi-1],b=levels[hi],f=(metres-a.h)/(b.h-a.h);
 return {h:metres,p:Math.exp(Math.log(a.p)+(Math.log(b.p)-Math.log(a.p))*f),temp:a.temp+(b.temp-a.temp)*f,u:a.u+(b.u-a.u)*f,v:a.v+(b.v-a.v)*f};
}
export function speeds(kias,weather,bearing){
 // KIAS is treated as KCAS: instrument/position errors require aircraft-specific data.
 const qc=101325*((1+.2*(kias/KT/340.294)**2)**3.5-1);
 const mach=Math.sqrt(5*((1+qc/weather.p)**(2/7)-1));
 if(mach>=1)throw Error('Bu deneme ses altı uçuş hesabı içindir.');
 const tas=mach*Math.sqrt(1.4*287.05287*weather.temp)*KT;
 const angle=bearing*RAD,tail=(weather.u*Math.sin(angle)+weather.v*Math.cos(angle))*KT,cross=(weather.u*Math.cos(angle)-weather.v*Math.sin(angle))*KT;
 if(Math.abs(cross)>=tas)throw Error('Yan rüzgâr nedeniyle girilen hızla rota hattı korunamıyor.');
 const gs=Math.sqrt(tas*tas-cross*cross)+tail;
 if(gs<=1)throw Error('Karşı rüzgâr nedeniyle girilen hızla rota üzerinde ilerlenemiyor.');
 return {tas,gs,tail,cross,wind:Math.hypot(weather.u,weather.v)*KT,windFrom:(Math.atan2(-weather.u,-weather.v)/RAD+360)%360};
}
export async function calculatePlan({points,kias,metres,departure,load,progress=()=>{},cancelled=()=>false}){
 if(!Number.isFinite(kias)||kias<30||kias>600)throw Error('KIAS 30–600 aralığında olmalı.');
 if(!Number.isFinite(metres)||metres<=0||metres>20000)throw Error('0–20000 metre aralığında pozitif AMSL irtifası girin.');
 if(!Number.isFinite(departure))throw Error('Geçerli bir kalkış tarihi ve saati girin.');
 const parts=splitRoute(points),rows=[];let now=departure;
 const check=()=>{if(cancelled())throw Error('Hesap iptal edildi.');};
 for(let i=0;i<parts.length;i++){
  check();progress(i,parts.length);const part=parts[i],payload=await load(part.point);check();
  let seconds=part.nm/kias*3600,s;
  let converged=false;
  for(let j=0;j<12;j++){
   s=speeds(kias,windAt(payload,now+seconds*500,metres),part.bearing);
   const next=part.nm/s.gs*3600;
   if(Math.abs(next-seconds)<.1){seconds=next;converged=true;break;}seconds=next;
  }
  if(!converged)throw Error('Rüzgâr ve geçiş saati hesabı yakınsamadı. Kalkış saatini değiştirin.');
  // Validate both segment boundaries: no extrapolation beyond forecast horizon.
  windAt(payload,now,metres);windAt(payload,now+seconds*1000,metres);
  rows.push({...part,...s,seconds,start:now,arrival:now+seconds*1000});now+=seconds*1000;
 }
 return {departure,arrival:now,minutes:(now-departure)/60000,nm:rows.reduce((s,r)=>s+r.nm,0),rows};
}
