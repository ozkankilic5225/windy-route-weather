<script>
 import {onDestroy} from 'svelte';
 import {getPointForecastData} from '@windy/fetch';
 import {calculatePlan,cloudStyle} from './flightPlan.js';
 import {map} from '@windy/map';
 export let points=[];
 export let flightAltitude='';
 export let altitudeUnit='ft';
 export let altitudeReference='amsl';
 let kias='120',departure=new Date(Date.now()+3*3600000).toISOString().slice(0,16),model='ecmwf';
 let clouds=true,spacingKm=10,low=20,high=70,cloudLayers=[],cloudPopup;
 let busy=false,error='',progress='',result=null,resultKey='',sequence=0;
 $: inputKey=JSON.stringify({points,flightAltitude,altitudeUnit,altitudeReference,kias,departure,model,clouds,spacingKm});
 $: stale=!!result&&resultKey!==inputKey;
 let runningKey='';
 $: if(busy&&runningKey!==inputKey)cancel();
 $: drawClouds(result,stale,busy,clouds,low,high);
 function removeClouds(){cloudLayers.forEach(layer=>map.removeLayer(layer));cloudLayers=[];if(cloudPopup){map.closePopup(cloudPopup);cloudPopup=null;}}
 function showCloud(row,index){
  const style=cloudStyle(row.cloud,Number(low),Number(high));
  const content=document.createElement('div');
  content.textContent=`Bölüm ${index+1} · ${style.label} · Model bulutluluğu: ${row.cloud===null?'veri yok':row.cloud.toFixed(0)+'%'} · ${flightAltitude} ${altitudeUnit} AMSL · Geçiş: ${format(row.sampleTime)} (Türkiye) · Bölüm: ${format(row.start)} – ${format(row.arrival)}`;
  if(cloudPopup)map.closePopup(cloudPopup);
  cloudPopup=L.popup().setLatLng([row.point.lat,row.point.lon]).setContent(content).openOn(map);
 }
 function drawClouds(plan,isStale,isBusy,enabled,lo,hi){
  removeClouds();if(!plan||isStale||isBusy||!enabled||!(Number(lo)>=0&&Number(lo)<Number(hi)&&Number(hi)<=100))return;
  cloudLayers=plan.rows.map(row=>L.polyline([[row.begin.lat,row.begin.lon],[row.point.lat,row.point.lon],[row.end.lat,row.end.lon]],{color:cloudStyle(row.cloud,Number(lo),Number(hi)).color,weight:7,opacity:.95,interactive:false}).addTo(map));
 }
 const format=t=>new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(t));
 function cancel(){sequence++;busy=false;progress='Hesap iptal edildi.';}
 function now(){departure=new Date(Date.now()+3*3600000).toISOString().slice(0,16);}
 async function calculate(){
  error='';result=null;progress='';
  if(altitudeReference!=='amsl'){error='Süre hesabı için yukarıdaki irtifa referansını AMSL seçin.';return;}
  const alt=Number(String(flightAltitude).replace(',','.'))*(altitudeUnit==='ft'?.3048:1);
  const speed=Number(String(kias).replace(',','.')),start=Date.parse(departure+(departure.length===16?':00':'')+'+03:00');
  const key=inputKey,token=++sequence;runningKey=key;busy=true;
  const route=points.map(p=>({...p}));
  try{
   const plan=await calculatePlan({points:route,kias:speed,metres:alt,departure:start,clouds,spacingKm:Number(spacingKm),cancelled:()=>token!==sequence,
    progress:(i,n)=>progress=`İrtifa ${clouds?'rüzgârı ve bulutu':'rüzgârı'} alınıyor: ${i+1}/${n}`,
    load:async point=>{
     let timeout;
     try{return (await Promise.race([
      getPointForecastData(model,{...point,days:10,step:1,source:'multiload'},{sounding:true,header:true,...(clouds?{meteogram:true}:{})}),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Windy tahmini 25 saniyede yanıt vermedi. Yeniden deneyin.')),25000);})
     ])).data;}finally{clearTimeout(timeout);}
    }
   });
   if(token===sequence){result=plan;resultKey=key;progress='';}
  }catch(e){if(token===sequence)error=e?.message||'Tahmin alınamadı.';}finally{if(token===sequence)busy=false;}
 }
 onDestroy(()=>{sequence++;removeClouds();});
</script>
<details class="flight-planner">
 <summary>Uçuş süresi ve rotada bulut · Yerel deneme</summary>
 <form on:submit|preventDefault={calculate}>
  <label for="rw-kias">Sabit uçuş hızı (KIAS)</label>
  <input id="rw-kias" type="text" inputmode="decimal" bind:value={kias} placeholder="120" required/>
  <label for="rw-departure">Kalkış tarihi ve saati · Türkiye (UTC+3)</label>
  <input id="rw-departure" type="datetime-local" bind:value={departure} required/>
  <button type="button" on:click={now}>Şimdiki saati kullan</button>
  <label for="rw-flight-model">İrtifa rüzgârı modeli</label>
  <select id="rw-flight-model" bind:value={model}><option value="ecmwf">ECMWF</option><option value="gfs">GFS</option></select>
  <small>İrtifa: {flightAltitude||'Girilmedi'} {altitudeUnit} · {altitudeReference.toUpperCase()}. Yukarıdaki irtifa alanını kullanır.</small>
  <label class="checkbox"><input type="checkbox" bind:checked={clouds}/> İrtifadaki bulut tahminine göre rotayı renklendir</label>
  {#if clouds}
   <label for="rw-spacing">Rota örnekleme aralığı</label>
   <select id="rw-spacing" bind:value={spacingKm}><option value={10}>En fazla 10 km · daha sık</option><option value={20}>En fazla 20 km</option><option value={40}>En fazla 40 km · daha az istek</option></select>
   <small>Renkler model bulutluluk yüzdesine göre belirlenir; buluta giriş olasılığı değildir. Küçük bulutlar örneklerin arasında kalabilir.</small>
  {/if}
  <button type="submit" disabled={busy||points.length<2}>Süreyi ve seçili tahminleri hesapla</button>
  {#if busy}<button type="button" on:click={cancel}>Hesabı iptal et</button>{/if}
 </form>
 {#if progress}<p role="status">{progress}</p>{/if}
 {#if error}<p class="error" role="alert">{error}</p>{/if}
 {#if stale}<p class="error">Rota veya uçuş bilgileri değişti. Sonucu yeniden hesaplayın.</p>{/if}
 {#if result&&!stale}
  <div class="result" role="status"><strong>{result.minutes.toFixed(1)} dakika · {result.nm.toFixed(1)} NM</strong><br/>Kalkış: {format(result.departure)}<br/><strong>Varış: {format(result.arrival)}</strong><br/><small>Tüm saatler Türkiye (UTC+3)</small></div>
  {#if clouds}
   <div class="legend"><span style="color:#22c55e">● Düşük: %{low} altı</span><span style="color:#facc15">● Orta: %{low}–{high} altı</span><span style="color:#ef4444">● Yüksek: %{high} ve üzeri</span><span style="color:#9ca3af">● Veri yok</span></div>
   <details><summary>Bulut renk eşikleri</summary><label for="rw-cloud-low">Orta bulutluluk başlangıcı (%)</label><input id="rw-cloud-low" type="number" min="0" max="99" bind:value={low}/><label for="rw-cloud-high">Yüksek bulutluluk başlangıcı (%)</label><input id="rw-cloud-high" type="number" min="1" max="100" bind:value={high}/>{#if !(Number(low)>=0&&Number(low)<Number(high)&&Number(high)<=100)}<p class="error">0 ≤ orta eşik &lt; yüksek eşik ≤ 100 olmalı.</p>{/if}<small>Bu eşikler görsel sınıflandırma içindir; uçuş emniyeti sınırı değildir.</small></details>
   <small>{result.rows.filter(r=>r.cloud===null).length}/{result.rows.length} bölümde bulut verisi yok. Aşağıdaki tabloda bölüm numarasına basarak haritada ayrıntısını açabilirsiniz.</small>
  {/if}
  <details><summary>Bölüm süreleri ve rüzgâr</summary><div class="table-scroll"><table><thead><tr><th>Bölüm</th>{#if clouds}<th>Model bulutluluğu</th>{/if}<th>NM</th><th>TAS kt</th><th>GS kt</th><th>Rüzgâr °/kt</th><th>Arka (+) / karşı (−) kt</th><th>dk</th><th>Geçiş saati</th></tr></thead><tbody>{#each result.rows as r,i}<tr><td>{#if clouds}<button type="button" class="row-button" on:click={()=>showCloud(r,i)}>{i+1} · Göster</button>{:else}{i+1}{/if}</td>{#if clouds}<td style:color={cloudStyle(r.cloud,Number(low),Number(high)).color}>{r.cloud===null?'Veri yok':r.cloud.toFixed(0)+'%'}</td>{/if}<td>{r.nm.toFixed(1)}</td><td>{r.tas.toFixed(0)}</td><td>{r.gs.toFixed(0)}</td><td>{r.windFrom.toFixed(0)}° / {r.wind.toFixed(0)}</td><td>{r.tail.toFixed(0)}</td><td>{(r.seconds/60).toFixed(1)}</td><td>{format(r.arrival)}</td></tr>{/each}</tbody></table></div></details>
 {/if}
 <small>Sabit KIAS ve AMSL irtifası; tırmanış, alçalma ve bekleme dahil değil. KIAS ≈ KCAS kabul edilir; uçak tipine ait gösterge düzeltmesi uygulanmaz. Rüzgâr ve sıcaklık, seçilen aralıktaki bölümlerin orta noktasında, tahmini geçiş saati ve irtifaya enterpole edilir. Deneysel süre tahminidir.</small>
</details>
<style>
 .checkbox{display:flex;align-items:center;gap:7px}.checkbox input{width:auto}.legend{display:grid;gap:4px;margin:8px 0;font-size:12px}.row-button{padding:3px 5px;font-size:11px}
 .flight-planner{margin-top:10px;border-top:1px solid #526378;padding-top:8px}summary{cursor:pointer;color:#ffce54}form{display:grid;gap:6px;margin-top:8px}label,small{font-size:12px;color:#d8e2eb}small{display:block;margin-top:7px}input,select,button{min-width:0;width:100%;box-sizing:border-box;background:#26384b;color:white;border:1px solid #60748a;border-radius:5px;padding:7px;font:inherit}button{cursor:pointer}button[type=submit]{background:#ffbd24;color:#172331}button:disabled{opacity:.4;cursor:default}.error{color:#ffb4b4}.result{margin:10px 0;padding:9px;background:#26384b;border-left:3px solid #ffbd24;font-size:13px}.table-scroll{overflow:auto;max-height:240px}table{border-collapse:collapse;font-size:11px;white-space:nowrap}td,th{padding:6px;border-bottom:1px solid #60748a;text-align:left}p{font-size:12px}
</style>
