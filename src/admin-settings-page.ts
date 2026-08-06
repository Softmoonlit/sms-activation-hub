import { CANDIDATE_POSITION_COUNTS, MIN_CANDIDATE_POSITION_COUNT } from './candidate-position.js';
import type { CandidateLocationSettings } from './default-candidate-locations.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function jsonForScript(value: unknown): string {
  const serialized = JSON.stringify(value);
  return (serialized ?? 'null').replace(/[<>&]/g, (character) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[character] ?? character);
}

function comboboxMarkup(position: number, selectedId?: number, label = '', template = false): string {
  const selectedName = escapeHtml(label);
  const inputClass = selectedName ? ' cb-selected' : '';
  const id = template ? '' : `cb${position}`;
  const ariaLabel = template ? '' : `候选地区 ${position + 1}`;
  const name = template ? '' : `candidate${position + 1}`;
  return `<label>候选地区 ${position + 1}<div class="cb" id="${id}"><input class="cb-input${inputClass}" type="text" value="${selectedName}" placeholder="输入地区名称搜索并选择…" autocomplete="off" aria-label="${ariaLabel}" aria-haspopup="listbox"><button type="button" class="cb-clear" tabindex="-1" title="清除选择">✕</button><input type="hidden" name="${name}" value="${selectedId ?? ''}"><ul class="cb-list" role="listbox"></ul></div></label>`;
}

export function candidateLocationSettingsContent(
  path: string,
  csrfToken: string,
  settings: CandidateLocationSettings,
  error?: string,
  saved = false,
): string {
  // 只把当前 HeroSMS 可查询数据嵌入页面；报价和库存不会写入默认配置。
  const locationsJson = jsonForScript(settings.locations.map((location) => {
    const quote = location.price === undefined || location.stock === undefined ? '暂无报价' : `价格 ${location.price.toString()}，库存 ${location.stock}`;
    return [location.id, `${location.name}，${quote}`];
  }));
  const configuredByPosition = new Map(settings.configuredLocations.map((location) => [location.position, location]));
  const candidateCount = settings.configurationComplete ? settings.configuredLocations.length : MIN_CANDIDATE_POSITION_COUNT;
  const configuredPositions = Array.from({ length: candidateCount }, (_, index) => configuredByPosition.get(index + 1));
  const initialIds = jsonForScript(configuredPositions.map((location) => location?.countryId ?? null));
  const initialLabels = configuredPositions.map((configured) => {
    const selectedLocation = configured ? settings.locations.find((location) => location.id === configured.countryId) : undefined;
    return configured?.countryName
      ? `${configured.countryName}${selectedLocation ? `，${selectedLocation.price === undefined || selectedLocation.stock === undefined ? '暂无报价' : `价格 ${selectedLocation.price.toString()}，库存 ${selectedLocation.stock}`}` : `，地区 ID ${configured.countryId}`}`
      : '';
  });
  const initialLabelsJson = jsonForScript(initialLabels);
  const comboboxes = configuredPositions.map((location, position) => comboboxMarkup(position, location?.countryId, initialLabels[position])).join('');
  const countOptions = CANDIDATE_POSITION_COUNTS
    .map((count) => `<option value="${count}"${count === candidateCount ? ' selected' : ''}>${count}</option>`).join('');
  const comboboxTemplate = `<template id="candidate-location-template">${comboboxMarkup(0, undefined, '', true)}</template>`;
  const comboboxScript = `<script>(()=>{const LOCS=${locationsJson};const INIT=${initialIds};const LABELS=${initialLabelsJson};const container=document.getElementById('candidate-locations');const count=document.getElementById('candidate-count');const template=document.getElementById('candidate-location-template');function esc(s){return s.replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]??c);}function hl(text,q){if(!q)return esc(text);const i=text.toLowerCase().indexOf(q.toLowerCase());if(i<0)return esc(text);return esc(text.slice(0,i))+'<span class="cb-hl">'+esc(text.slice(i,i+q.length))+'</span>'+esc(text.slice(i+q.length));}function field(idx){const fragment=template.content.cloneNode(true);const label=fragment.querySelector('label');label.firstChild.textContent='候选地区 '+(idx+1);const wrap=fragment.querySelector('.cb');wrap.id='cb'+idx;wrap.querySelector('.cb-input').setAttribute('aria-label','候选地区 '+(idx+1));wrap.querySelector('input[type=hidden]').name='candidate'+(idx+1);return fragment;}function init(idx){const wrap=document.getElementById('cb'+idx);const inp=wrap.querySelector('.cb-input');const clr=wrap.querySelector('.cb-clear');const hid=wrap.querySelector('input[type=hidden]');const list=wrap.querySelector('.cb-list');let selId=INIT[idx];let selName=LABELS[idx]||'';let activeIdx=-1;if(selId!=null){hid.value=selId;inp.value=selName;inp.classList.add('cb-selected');}function render(q){list.innerHTML='';activeIdx=-1;const matched=LOCS.filter(l=>!q||l[1].toLowerCase().includes(q.toLowerCase()));if(!matched.length){list.innerHTML='<li class="cb-empty">无匹配地区</li>';}else{matched.forEach((l)=>{const li=document.createElement('li');li.className='cb-opt';li.setAttribute('role','option');li.dataset.id=l[0];li.dataset.name=l[1];li.innerHTML=hl(l[1],q);li.addEventListener('mousedown',e=>{e.preventDefault();pick(l[0],l[1]);});list.appendChild(li);});}list.classList.add('cb-open');}function pick(id,name){selId=id;selName=name;INIT[idx]=id;LABELS[idx]=name;hid.value=id;inp.value=name;inp.classList.add('cb-selected');list.classList.remove('cb-open');}function clear(){selId=null;selName='';INIT[idx]=null;LABELS[idx]='';hid.value='';inp.value='';inp.classList.remove('cb-selected');list.classList.remove('cb-open');inp.focus();}inp.addEventListener('focus',()=>render(inp.classList.contains('cb-selected')?'':inp.value));inp.addEventListener('input',()=>{if(inp.classList.contains('cb-selected')&&inp.value!==selName){inp.classList.remove('cb-selected');hid.value='';selId=null;INIT[idx]=null;LABELS[idx]='';}render(inp.value);});inp.addEventListener('blur',()=>{setTimeout(()=>{list.classList.remove('cb-open');if(selId!=null&&inp.value!==selName){inp.value=selName;inp.classList.add('cb-selected');}else if(selId==null){inp.value='';inp.classList.remove('cb-selected');}},150);});inp.addEventListener('keydown',e=>{const opts=[...list.querySelectorAll('.cb-opt')];if(e.key==='ArrowDown'){e.preventDefault();activeIdx=Math.min(activeIdx+1,opts.length-1);opts.forEach((o,i)=>o.classList.toggle('cb-active',i===activeIdx));opts[activeIdx]?.scrollIntoView({block:'nearest'});}else if(e.key==='ArrowUp'){e.preventDefault();activeIdx=Math.max(activeIdx-1,0);opts.forEach((o,i)=>o.classList.toggle('cb-active',i===activeIdx));opts[activeIdx]?.scrollIntoView({block:'nearest'});}else if(e.key==='Enter'&&activeIdx>=0&&opts[activeIdx]){e.preventDefault();const o=opts[activeIdx];pick(Number(o.dataset.id),o.dataset.name);}else if(e.key==='Escape'){list.classList.remove('cb-open');inp.blur();}});clr.addEventListener('click',clear);}Array.from(container.children).forEach((_,idx)=>init(idx));count.addEventListener('change',()=>{const next=Number(count.value);while(container.children.length>next)container.lastElementChild.remove();INIT.length=next;LABELS.length=next;while(container.children.length<next){const idx=container.children.length;INIT[idx]=null;LABELS[idx]='';container.append(field(idx));init(idx);}});document.addEventListener('click',e=>{if(!e.target.closest('.cb'))document.querySelectorAll('.cb-list').forEach(l=>l.classList.remove('cb-open'));});})();<\/script>`;
  const errorMarkup = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  const savedBadge = saved
    ? `<span id="save-toast" role="status" aria-live="polite" style="margin-left:.75rem;color:#166534;font-size:.875rem">✓ 已保存</span><script>(()=>{setTimeout(()=>{const t=document.getElementById('save-toast');if(t)t.remove();history.replaceState(null,'',location.pathname);},3000);})();<\/script>`
    : '';
  const heroStatus = settings.heroSmsAvailable
    ? `<p><strong>HeroSMS 已连接</strong>${savedBadge}</p>`
    : `<p class="error" role="alert">暂时无法读取 HeroSMS 设置；以下仅显示数据库中已保存的候选位置。</p>${savedBadge}`;
  const balanceMarkup = settings.balance === undefined ? '' : `<p>余额：${settings.balance.toFixed(2)}</p>`;
  const configurationWarning = settings.configurationComplete
    ? ''
    : '<p class="error" role="alert">当前默认候选位置配置不完整，请重新选择并保存。</p>';
  return `<section class="settings">${heroStatus}${balanceMarkup}${configurationWarning}${errorMarkup}<form method="post" action="/${path}/settings"><input type="hidden" name="csrf" value="${csrfToken}"><label for="candidate-count">候选位置数量<select id="candidate-count" name="candidateCount">${countOptions}</select></label><div id="candidate-locations">${comboboxes}</div><button type="submit">保存默认候选地区</button></form></section>${comboboxTemplate}${comboboxScript}`;
}
