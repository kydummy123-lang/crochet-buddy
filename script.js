let editingPatternId = null;

function nl2br(s){ return String(s).replace(/\n/g,"<br>"); }

function removeRoundImage(i){
  const p=data.patterns.find(x=>x.id===editingPatternId);
  if(p?.rounds?.[i]){p.rounds[i].image="";delete p.rounds[i].img;saveData();editPattern(p.id);toast("Image removed ✓");}
}

const KEY="crochetBuddyV2";
const PROFILE_KEY="crochetBuddyProfilesV1";
const defaultCategories=["Amigurumi","Bags","Wearables","Home Decor","Flowers","Accessories","Toys","Blankets","Other"];
// ☁️ Crochet Buddy cloud connection + image storage
const SUPABASE_URL = "https://fchlwbdazyupkkcjvmkp.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_6nexdusB9XeANQad4FTnww_qibUOe1c";
const IMAGE_BUCKET = "crochet-images";
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
let cloudUser = null;
let cloudReady = false;
let cloudSaveTimer = null;
const pendingImages = {};
let patternSearchTerm = "";
let favoritesOnly = false;
function setSyncStatus(text, state="") { const el=document.getElementById("syncStatus"); if(el){el.textContent=text;el.dataset.state=state;} }
function setAuthMessage(text, ok=false){ const el=document.getElementById("authMessage"); if(el){el.textContent=text;el.classList.toggle("ok",ok);} }
function showAuthScreen(show=true){ document.getElementById("authScreen")?.classList.toggle("hidden",!show); if(show) document.getElementById("lockScreen")?.classList.add("hidden"); }
function localSnapshot(){ return {activeId:profileStore.activeId, profiles:profileStore.profiles}; }
function isDataImage(value){return typeof value==="string" && value.startsWith("data:image/");}
function fileToDataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});}
async function optimizeImage(file){
  if(!file)return null;
  try{
    const dataUrl=await fileToDataUrl(file);
    const img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=dataUrl;});
    const max=1600, scale=Math.min(1,max/Math.max(img.naturalWidth||img.width,img.naturalHeight||img.height));
    const w=Math.max(1,Math.round((img.naturalWidth||img.width)*scale)), h=Math.max(1,Math.round((img.naturalHeight||img.height)*scale));
    const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext("2d");ctx.drawImage(img,0,0,w,h);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",0.8));
    return blob||file;
  }catch(e){console.warn("Image optimization skipped",e);return file;}
}
async function uploadImageFile(file, kind="image"){
  if(!supabaseClient||!cloudUser||!file)return null;
  const blob=await optimizeImage(file);
  const safeKind=String(kind).replace(/[^a-z0-9_-]/gi,"-").toLowerCase();
  const path=`${cloudUser.id}/${safeKind}/${Date.now()}-${Math.random().toString(36).slice(2,9)}.jpg`;
  const {error}=await supabaseClient.storage.from(IMAGE_BUCKET).upload(path,blob,{contentType:"image/jpeg",upsert:false,cacheControl:"31536000"});
  if(error){console.error(error);throw error;}
  const {data}=supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
async function migrateDataImages(){
  if(!cloudUser)return false;
  let changed=false;
  const uploadIfNeeded=async(value,kind)=>{
    if(!isDataImage(value))return value;
    try{
      const res=await fetch(value);const blob=await res.blob();
      return await uploadImageFile(blob,kind);
    }catch(e){console.error("Image migration failed",e);throw e;}
  };
  for(const [pid,profile] of Object.entries(profileStore.profiles||{})){
    const d=normalizeData(profile.data);
    for(const ptn of d.patterns){
      if(isDataImage(ptn.cover)){ptn.cover=await uploadIfNeeded(ptn.cover,"pattern-cover");changed=true;}
      for(let i=0;i<(ptn.rounds||[]).length;i++){
        const r=ptn.rounds[i];
        const old=r.image||r.img||"";
        if(isDataImage(old)){r.image=await uploadIfNeeded(old,"round");delete r.img;changed=true;}
      }
    }
    for(const l of (d.myLearnings||[])){
      if(isDataImage(l.image)){l.image=await uploadIfNeeded(l.image,"learning");changed=true;}
    }
    profile.data=d;
  }
  if(changed){
    data=normalizeData(profileStore.profiles[activeProfileId].data);
    profileStore.activeId=activeProfileId;
  }
  return changed;
}
async function saveLocalSafe(){
  profileStore.activeId=activeProfileId;
  profileStore.profiles[activeProfileId].data=data;
  localStorage.setItem(PROFILE_KEY,JSON.stringify(profileStore));
}
async function loadCloudData(user){
  if(!supabaseClient || !user) return false;
  setSyncStatus("☁️ Loading…","loading");
  const {data:row,error}=await supabaseClient.from("user_data").select("data").eq("user_id",user.id).maybeSingle();
  if(error){ console.error(error); setSyncStatus("☁️ Sync error","error"); toast("Cloud data could not be loaded. Check the setup."); return false; }
  try{
    if(row?.data?.profiles){
      profileStore=row.data;
      activeProfileId=profileStore.activeId||Object.keys(profileStore.profiles)[0];
      if(!profileStore.profiles[activeProfileId]) activeProfileId=Object.keys(profileStore.profiles)[0];
      data=normalizeData(profileStore.profiles[activeProfileId].data);
    } else {
      // First login: use the existing local journal, but move old embedded images to cloud storage first.
      profileStore.activeId=activeProfileId;
      await migrateDataImages();
      const payload=localSnapshot();
      const {error:upErr}=await supabaseClient.from("user_data").upsert({user_id:user.id,data:payload,updated_at:new Date().toISOString()});
      if(upErr)throw upErr;
    }
    // Existing cloud data from v16 may contain embedded base64 images. Move those out of JSON.
    const migrated=await migrateDataImages();
    if(migrated){
      const {error:upErr}=await supabaseClient.from("user_data").upsert({user_id:user.id,data:localSnapshot(),updated_at:new Date().toISOString()});
      if(upErr)throw upErr;
    }
    await saveLocalSafe();
  }catch(err){
    console.error(err);setSyncStatus("☁️ Storage setup needed","error");toast("Your journal is safe for now, but image storage needs to be set up in Supabase.");return false;
  }
  cloudReady=true;
  applyTheme(); renderAll();
  setSyncStatus("☁️ Synced","ok");
  return true;
}
async function cloudSaveNow(){
  if(!cloudReady || !cloudUser || !supabaseClient) return;
  const payload=localSnapshot();
  const {error}=await supabaseClient.from("user_data").upsert({user_id:cloudUser.id,data:payload,updated_at:new Date().toISOString()});
  if(error){console.error(error);setSyncStatus("☁️ Sync error","error");toast("Saved on this device, but cloud sync failed.");}
  else setSyncStatus("☁️ Synced","ok");
}
async function cloudSave(){
  if(!cloudReady || !cloudUser || !supabaseClient) return;
  clearTimeout(cloudSaveTimer);
  setSyncStatus("☁️ Saving…","saving");
  cloudSaveTimer=setTimeout(cloudSaveNow,400);
}
async function logoutCloud(){
  if(supabaseClient) await supabaseClient.auth.signOut();
  cloudUser=null;cloudReady=false;
  document.getElementById("lockScreen")?.classList.add("hidden");
  setSyncStatus("☁️ Signed out");
  showAuthScreen(true);
}

const tips=["Count your stitches at the end of every round.","Keep scrap yarn nearby for testing tension.","Frogging is part of learning! 🐸","Mark the first stitch of every round.","Write down changes you make so you can repeat them later."];
const lessons=[["01","Slip Knot","Learn the starting loop used for most crochet projects.","🪢"],["02","Chain Stitch (ch)","Make a foundation chain and practice even tension.","〰️"],["03","Single Crochet (sc)","Your first basic stitch and a building block for many projects.","🧶"],["04","Half Double Crochet (hdc)","A taller stitch with a soft, flexible fabric.","🌷"],["05","Double Crochet (dc)","A taller stitch that works up quickly.","✨"],["06","Increase (inc)","Learn how to add stitches and shape your project.","📈"],["07","Decrease (dec)","Learn how to reduce stitches and shape your work.","📉"],["08","Reading Patterns","Understand abbreviations, repeats, rounds and stitch counts.","📖"]];
const stitches=[["SC","Single Crochet","Insert hook, yarn over and pull up a loop. Yarn over and pull through both loops."],["HDC","Half Double Crochet","Yarn over, insert hook, yarn over and pull up a loop. Yarn over and pull through all three loops."],["DC","Double Crochet","Yarn over, insert hook, yarn over and pull up a loop. Yarn over, pull through two; yarn over, pull through two."],["CH","Chain","Yarn over and pull the yarn through the loop on your hook."],["SL ST","Slip Stitch","Insert hook, yarn over, and pull through the stitch and the loop on your hook."],["INC","Increase","Make two stitches into the same stitch."],["DEC","Decrease","Combine two stitches into one stitch."]];
function normalizeData(d){d=d||{};d.categories=d.categories||[...defaultCategories];d.patterns=d.patterns||[];d.projects=d.projects||[];d.yarn=d.yarn||[];d.learnedLessons=d.learnedLessons||[];d.myLearnings=d.myLearnings||[];return d}
function freshProfile(name="My Crochet Journal",avatar="🧶",theme="rose"){return {name,avatar,theme,data:normalizeData({categories:[...defaultCategories],patterns:[],projects:[],yarn:[],learnedLessons:[],myLearnings:[]})}}
let profileStore=JSON.parse(localStorage.getItem(PROFILE_KEY)||"null");
if(!profileStore||!profileStore.profiles){
  const legacy=JSON.parse(localStorage.getItem(KEY)||"null");
  const migrated=normalizeData(legacy||{categories:[...defaultCategories],patterns:[],projects:[{name:"Daisy Bag",progress:80,status:"WIP",notes:"Finish the handles."}],yarn:[],learnedLessons:[],myLearnings:[]});
  profileStore={activeId:"profile-1",profiles:{"profile-1":{name:"My Crochet Journal",avatar:"🧶",theme:"rose",data:migrated}}};
  localStorage.setItem(PROFILE_KEY,JSON.stringify(profileStore));
}
let activeProfileId=profileStore.activeId||Object.keys(profileStore.profiles)[0];
if(!profileStore.profiles[activeProfileId])activeProfileId=Object.keys(profileStore.profiles)[0];
let data=normalizeData(profileStore.profiles[activeProfileId].data);
profileStore.activeId=activeProfileId;
function saveData(){
  try{
    profileStore.activeId=activeProfileId;
    profileStore.profiles[activeProfileId].data=data;
    localStorage.setItem(PROFILE_KEY,JSON.stringify(profileStore));
    cloudSave();
    return true;
  }catch(err){
    alert("Crochet Buddy could not save this change. Your browser storage may be full, especially if many large images were added. Try a smaller image or export a backup first.");
    console.error(err);
    return false;
  }
}
function save(){if(saveData()) renderAll()}

function toast(msg){
  let t=document.getElementById("toast");
  if(!t){t=document.createElement("div");t.id="toast";t.className="toast";document.body.appendChild(t)}
  t.textContent=msg;t.classList.add("show");clearTimeout(window.__toastTimer);window.__toastTimer=setTimeout(()=>t.classList.remove("show"),1800);
}
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function removeUnexpectedHomeImages(){document.querySelectorAll("#home img").forEach(img=>img.remove())}
function go(id){document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));document.getElementById(id).classList.add("active");document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.go===id));if(id==="home")removeUnexpectedHomeImages();scrollTo({top:0,behavior:"smooth"})}
document.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>go(b.dataset.go)));
function modal(html){document.getElementById("modalContent").innerHTML=html;document.getElementById("modal").classList.remove("hidden")}
function closeModal(){document.getElementById("modal").classList.add("hidden")}
document.getElementById("closeModal").onclick=closeModal;
document.getElementById("modal").addEventListener("click",e=>{if(e.target.id==="modal")closeModal()});

const THEMES={
  rose:{label:"Cozy Rose",emoji:"🌸",vars:{cream:"#fffaf6",paper:"#fffdfb",rose:"#e9b8b0",roseDark:"#a96762",ink:"#4d4542",muted:"#857a76",line:"#eadfda"}},
  sage:{label:"Sage Garden",emoji:"🌿",vars:{cream:"#f5faf5",paper:"#fcfffc",rose:"#b9cdbb",roseDark:"#66806a",ink:"#435047",muted:"#748078",line:"#dce7dd"}},
  lavender:{label:"Lavender Dream",emoji:"💜",vars:{cream:"#faf7fc",paper:"#fffaff",rose:"#d8c8df",roseDark:"#80668d",ink:"#4f4654",muted:"#817686",line:"#e7deeb"}},
  sky:{label:"Sky Blue",emoji:"🩵",vars:{cream:"#f5fbff",paper:"#fcffff",rose:"#b9d9e8",roseDark:"#5e8395",ink:"#43515a",muted:"#71818a",line:"#dcebf1"}},
  mocha:{label:"Warm Mocha",emoji:"☕",vars:{cream:"#fbf7f2",paper:"#fffdf9",rose:"#d8b9a5",roseDark:"#8b6654",ink:"#50443e",muted:"#83756e",line:"#e8ddd4"}},
  dark:{label:"Cozy Night",emoji:"🌙",vars:{cream:"#211e20",paper:"#2b272a",rose:"#b98587",roseDark:"#d59a9b",ink:"#f4ece8",muted:"#c7bdb9",line:"#4a4246"}}
};
function applyTheme(){const t=THEMES[profileStore.profiles[activeProfileId]?.theme]||THEMES.rose;const r=document.documentElement;Object.entries(t.vars).forEach(([k,v])=>r.style.setProperty("--"+({roseDark:"rose-dark"}[k]||k),v));document.body.dataset.theme=profileStore.profiles[activeProfileId]?.theme||"rose";const b=document.getElementById("profileBtn");if(b){const p=profileStore.profiles[activeProfileId]||{};b.innerHTML=p.avatarImage?`<img class="top-profile-photo" src="${esc(p.avatarImage)}" alt="">`:"👤";b.title="Your Profile & Account"}}
function openProfile(){
 const active=profileStore.profiles[activeProfileId]||freshProfile();
 const profiles=Object.entries(profileStore.profiles).map(([id,p])=>`<div class="profile-option ${id===activeProfileId?"active-profile":""}"><button class="profile-main" onclick="switchProfile('${id}\')"><span class="profile-avatar">${p.avatarImage?`<img class="profile-picture-img" src="${esc(p.avatarImage)}" alt="">`:esc(p.avatar||"🧶")}</span><span><strong>${esc(p.name)}</strong><small>${THEMES[p.theme]?.emoji||"🎨"} ${esc(THEMES[p.theme]?.label||"Theme")}</small></span></button>${Object.keys(profileStore.profiles).length>1&&id!==activeProfileId?`<button class="danger profile-delete" onclick="deleteProfile('${id}\')">Delete</button>`:""}</div>`).join("");
 const email=cloudUser?.email||"Not signed in";
 const syncText=cloudUser?"☁️ Cloud account connected":"⚠️ Not signed in";
 modal(`<span class="pill">YOUR PROFILE & ACCOUNT</span><div class="profile-hero-avatar">${active.avatarImage?`<img class="profile-picture-img" src="${esc(active.avatarImage)}" alt="Profile picture">`:`<span>${esc(active.avatar||"🧶")}</span>`}</div><h2>${esc(active.name)}</h2><div class="account-box"><strong>${syncText}</strong><div class="meta">${esc(email)}</div></div><div class="profile-account-actions"><button class="primary-btn full" onclick="editCurrentProfile()">🎨 Customize Profile</button><button class="primary-btn full" onclick="newProfile()">➕ New Profile</button><button class="danger full account-logout-btn" onclick="logoutFromProfile()">☁️ Log Out of Crochet Buddy</button></div><h3 style="margin-top:18px">Your Profiles</h3><div class="profile-list">${profiles}</div><div class="meta" style="margin-top:12px">🔒 PIN 0705 protects this device. Your online account controls cloud sync.</div>`);
}
function logoutFromProfile(){
  if(!confirm("Log out of your Crochet Buddy cloud account? Your cloud data will stay online.")) return;
  closeModal();
  logoutCloud();
}

function newProfile(){modal(`<h2>＋ New Crochet Profile</h2><label>Profile name</label><input id="profileName" class="form-input" placeholder="e.g. Mom's Crochet Journal"><label>Choose an avatar</label><input id="profileAvatar" class="form-input" value="🧶" maxlength="4"><label>Theme</label><select id="profileTheme" class="form-input">${Object.entries(THEMES).map(([k,t])=>`<option value="${k}">${t.emoji} ${t.label}</option>`).join("")}</select><div class="form-actions"><button class="mini-btn" onclick="openProfile()">Cancel</button><button class="primary-btn" onclick="createProfile()">Create Profile ✓</button></div>`)}
async function createProfile(){const name=document.getElementById("profileName").value.trim()||"Crochet Journal";const avatar=document.getElementById("profileAvatar").value.trim()||"🧶";const theme=document.getElementById("profileTheme").value;const id="profile-"+Date.now();profileStore.profiles[id]={name,avatar,theme,data:normalizeData({categories:[...defaultCategories],patterns:[],projects:[],yarn:[],learnedLessons:[],myLearnings:[]})};profileStore.activeId=id;activeProfileId=id;data=profileStore.profiles[id].data;localStorage.setItem(PROFILE_KEY,JSON.stringify(profileStore));applyTheme();closeModal();renderAll();await cloudSave();toast("Profile created and synced ✓")}
function switchProfile(id){if(!profileStore.profiles[id])return;saveData();activeProfileId=id;profileStore.activeId=id;data=normalizeData(profileStore.profiles[id].data);applyTheme();closeModal();renderAll();go("home");toast("Switched profile ✓")}
function deleteProfile(id){if(Object.keys(profileStore.profiles).length<=1)return alert("Keep at least one profile.");if(!confirm("Delete this profile and all of its crochet data? This cannot be undone."))return;delete profileStore.profiles[id];localStorage.setItem(PROFILE_KEY,JSON.stringify(profileStore));openProfile()}
function editCurrentProfile(){const p=profileStore.profiles[activeProfileId];pendingImages.profileImage=null;modal(`<h2>⚙️ Customize Profile</h2><div class="profile-edit-avatar">${p.avatarImage?`<img class="profile-picture-img" src="${esc(p.avatarImage)}" alt="Current profile photo">`:`<span>${esc(p.avatar||"🧶")}</span>`}</div><label>Profile name</label><input id="profileName" class="form-input" value="${esc(p.name)}"><label>Profile picture</label><input id="profileImage" type="file" accept="image/*" class="form-input" onchange="addImage(this,'profileImageValue')"><input id="profileImageValue" type="hidden" value="${esc(p.avatarImage||"")}"><small class="meta">Choose a photo from your phone or computer. It will be saved to your cloud account.</small><label>Avatar / emoji (used if no picture)</label><input id="profileAvatar" class="form-input" value="${esc(p.avatar||"🧶")}" maxlength="4"><label>Theme</label><select id="profileTheme" class="form-input">${Object.entries(THEMES).map(([k,t])=>`<option value="${k}" ${p.theme===k?"selected":""}>${t.emoji} ${t.label}</option>`).join("")}</select><div class="form-actions"><button class="mini-btn" onclick="openProfile()">Cancel</button><button class="primary-btn" onclick="saveCurrentProfile()">Save Profile ✓</button></div>`)}
async function saveCurrentProfile(){const p=profileStore.profiles[activeProfileId];p.name=document.getElementById("profileName").value.trim()||"Crochet Journal";p.avatar=document.getElementById("profileAvatar").value.trim()||"🧶";p.theme=document.getElementById("profileTheme").value;let image=document.getElementById("profileImageValue")?.value||p.avatarImage||"";if(pendingImages.profileImage){if(!cloudUser){alert("Please sign in to save a profile picture to cloud storage.");return;}try{setSyncStatus("☁️ Uploading profile picture…","saving");image=await uploadImageFile(pendingImages.profileImage,"profile");delete pendingImages.profileImage;}catch(e){alert("The profile picture could not be uploaded. Please try again.");return;}}p.avatarImage=image;profileStore.activeId=activeProfileId;localStorage.setItem(PROFILE_KEY,JSON.stringify(profileStore));applyTheme();closeModal();await cloudSave();toast("Profile updated and synced ✓")}

function renderProjects(){
 const h=data.projects.length?data.projects.map((p,i)=>{
   const pat=data.patterns.find(x=>x.id===p.patternId);
   const linked=pat?`<div class="linked-pattern">🧶 Pattern: <strong>${esc(pat.name)}</strong> · ${esc(pat.category)}</div>`:"";
   const autoProgress=pat?getPatternProgress(pat):Math.min(100,Math.max(0,Number(p.progress)||0));
   const roundNote=pat&&pat.rounds?.length?`<div class="project-round-note">Last completed: ${getLastRound(pat)>=0?`R${getLastRound(pat)+1}`:"None yet"} of ${pat.rounds.length}</div>`:"";
   if(pat)p.progress=autoProgress;
   return `<div class="item">
    <div class="item-head"><div><h3>${esc(p.name)}</h3><div class="meta">${esc(p.status||"WIP")}</div></div><button class="danger" onclick="removeItem('projects',${i})">Delete</button></div>
    ${linked}
    <div class="progress"><div class="bar" style="width:${autoProgress}%"></div></div>
    <div class="meta">${autoProgress}% complete${pat?' · Automatically calculated from pattern rounds':''}</div>${roundNote}
    <div class="pattern-actions">${pat?`<button class="mini-btn view-btn" onclick="viewPattern('${pat.id}','${p.id}')">Open Pattern</button>`:""}<button class="mini-btn edit-btn" onclick="editProject(${i})">Edit Project</button></div>
   </div>`
 }).join(""):'<div class="empty">No projects yet. Add your first project! 🧶</div>';
 document.getElementById("projectList").innerHTML=h;
 document.getElementById("homeProjects").innerHTML=data.projects.length?data.projects.slice(0,2).map(p=>{
   const pat=data.patterns.find(x=>x.id===p.patternId);
   const hp=pat?getPatternProgress(pat):Math.min(100,Math.max(0,Number(p.progress)||0));
   if(pat)p.progress=hp;
   return `<div class="item"><h3>${esc(p.name)}</h3>${pat?`<div class="meta">🧶 ${esc(pat.name)}</div>`:""}<div class="progress"><div class="bar" style="width:${hp}%"></div></div><div class="meta">${hp}% complete</div></div>`
 }).join(""):'<div class="empty">Your next creation starts here. ✨</div>'
}
function getLastRound(p){
 if(!p?.rounds?.length)return -1;
 let last=-1;
 p.rounds.forEach((r,i)=>{if(r.done)last=i});
 return last;
}
function getPatternProgress(p){
 const rounds=p?.rounds||[];
 if(!rounds.length)return 0;
 const last=getLastRound(p);
 if(last<0)return 0;
 return Math.min(100, Math.round(((last+1)/rounds.length)*100));
}
function syncLinkedProjectProgress(p){
 if(!p)return;
 const progress=getPatternProgress(p);
 data.projects.forEach(project=>{if(project.patternId===p.id) project.progress=progress;});
}
function ensurePatternTools(){
  const tools=document.querySelector(".pattern-tools"); if(!tools)return;
  if(!document.getElementById("patternSearch")){const input=document.createElement("input");input.id="patternSearch";input.className="search";input.placeholder="🔎 Search patterns...";input.addEventListener("input",e=>{patternSearchTerm=e.target.value;renderPatterns();});tools.insertBefore(input,document.getElementById("addPatternBtn"));}
  if(!document.getElementById("favoritesFilterBtn")){const b=document.createElement("button");b.id="favoritesFilterBtn";b.className="secondary";b.textContent="♡ Favorites";b.onclick=()=>{favoritesOnly=!favoritesOnly;b.textContent=favoritesOnly?"❤️ Favorites":"♡ Favorites";renderPatterns();};tools.insertBefore(b,document.getElementById("addPatternBtn"));}
}
function togglePatternFavorite(id){const p=data.patterns.find(x=>x.id===id);if(!p)return;p.favorite=!p.favorite;if(saveData())renderPatterns();}
function renderPatterns(){
 ensurePatternTools();
 const filter=document.getElementById("categoryFilter").value||"All";
 const q=patternSearchTerm.trim().toLowerCase();
 const list=data.patterns.filter(p=>{const matchesCat=filter==="All"||p.category===filter;const hay=[p.name,p.category,p.difficulty,p.yarn,p.hook].join(" ").toLowerCase();const matchesSearch=!q||hay.includes(q);const matchesFav=!favoritesOnly||!!p.favorite;return matchesCat&&matchesSearch&&matchesFav;});
 document.getElementById("patternList").innerHTML=list.length?list.map(p=>{
   const last=getLastRound(p);
   const linked=data.projects.filter(x=>x.patternId===p.id).length;
   return `<div class="item pattern-card">
    ${p.cover?`<img class="pattern-cover" src="${p.cover}" alt="">`:""}
    <div class="item-head"><div><span class="category-badge">${esc(p.category)}</span><h3 style="margin-top:8px">${esc(p.name)}</h3><div class="meta">${esc(p.difficulty||"Beginner")} · ${p.rounds?.length||0} rounds · ${esc(p.yarn||"Yarn not set")}</div></div></div>
    ${p.rounds?.length?`<div class="meta">Last completed: ${last>=0?`R${last+1}`:"None yet"}</div>`:""}
    ${linked?`<div class="linked-pattern">📋 ${linked} project${linked>1?"s":""} linked</div>`:""}
    <div class="pattern-actions"><button class="mini-btn view-btn" onclick="viewPattern('${p.id}')">👁 View</button><button class="mini-btn edit-btn" onclick="editPattern('${p.id}')">✏️ Edit</button><button class="mini-btn" onclick="togglePatternFavorite('${p.id}')">${p.favorite?"❤️ Favorited":"♡ Favorite"}</button><button class="mini-btn danger" onclick="deletePattern('${p.id}')">🗑 Delete</button></div>
   </div>`
 }).join(""):'<div class="empty">No patterns in this category yet. Tap “New Pattern” to start. 🧶</div>'
}
function renderYarn(){document.getElementById("yarnList").innerHTML=data.yarn.length?data.yarn.map((y,i)=>`<div class="item"><div class="item-head"><div><h3>${esc(y.name)}</h3><div class="meta">${esc(y.color||"")} · ${esc(y.weight||"")} · ${esc(y.amount||"")}</div></div><div class="item-actions"><button class="mini-btn edit-btn" onclick="editYarn(${i})">✏️ Edit</button><button class="danger" onclick="removeItem('yarn',${i})">Delete</button></div></div></div>`).join(""):'<div class="empty">Your yarn stash is waiting for its first entry. 🧵</div>'}
function renderLessons(){
  const learned=new Set(data.learnedLessons||[]);
  const builtIn=lessons.map(l=>{
    const isLearned=learned.has(l[0]);
    return `<div class="lesson item ${isLearned?"learned-item":""}">
      <div class="lesson-top"><span class="number">LESSON ${l[0]}</span><button class="learned-toggle ${isLearned?"active":""}" onclick="toggleLessonLearned(event,'${l[0]}')">${isLearned?"✓ Learned":"○ Mark Learned"}</button></div>
      <div onclick="lesson('${l[0]}')"><h3>${l[3]} ${esc(l[1])}</h3><p>${esc(l[2])}</p></div>
    </div>`;
  }).join("");
  const mine=(data.myLearnings||[]).map((x,i)=>`<div class="item my-learning-card">
    <div class="item-head"><div><span class="pill">MY LEARNING</span><h3 style="margin-top:8px">${esc(x.title)}</h3></div><div class="item-actions"><button class="mini-btn edit-btn" onclick="editMyLearning(${i})">✏️ Edit</button><button class="danger" onclick="deleteMyLearning(${i})">Delete</button></div></div>
    <div class="meta">${esc(x.category||"Other")} · ${esc(x.status||"Learned")} · ${esc(x.date||"")}</div>
    ${x.notes?`<p class="learning-notes">${nl2br(esc(x.notes))}</p>`:""}
    ${x.link?`<div class="learning-link"><a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">🔗 Open Attached Link</a></div>`:""}
    ${x.image?`<img class="learning-image" src="${esc(x.image)}" alt="${esc(x.title)}">`:""}
  </div>`).join("");
  document.getElementById("lessonList").innerHTML=`
    <div class="learn-toolbar"><div><h3>What I’ve Learned 🌱</h3><p>Add your own crochet discoveries, techniques, or notes.</p></div><button class="primary-btn" onclick="addMyLearning()">＋ Add Learning</button></div>
    ${mine?`<div class="stack learning-stack">${mine}</div>`:""}
    <div class="section-title learning-section-title"><h3>Beginner Lessons</h3></div>
    <div class="lesson-grid">${builtIn}</div>`;
}
function toggleLessonLearned(e,id){
  e.stopPropagation();
  data.learnedLessons=data.learnedLessons||[];
  const i=data.learnedLessons.indexOf(id);
  if(i>=0)data.learnedLessons.splice(i,1);else data.learnedLessons.push(id);
  if(saveData())renderLessons();
}
function addMyLearning(){
  modal(`<h2>＋ Add Something I Learned 🌱</h2>
    <label>What did you learn?</label><input id="learnTitle" class="form-input" placeholder="e.g. How to make a magic ring">
    <label>Category</label><select id="learnCategory" class="form-input"><option>Stitch</option><option>Technique</option><option>Pattern Reading</option><option>Yarn & Hook</option><option>Tip / Discovery</option><option>Other</option></select>
    <label>Status</label><select id="learnStatus" class="form-input"><option>Learned</option><option>Practicing</option><option>Need to Practice</option></select>
    <label>Notes</label><textarea id="learnNotes" class="form-textarea" placeholder="Write what you learned, steps, tips, or reminders..."></textarea>
    <label>Attach link</label><input id="learnLink" type="url" class="form-input" placeholder="https://youtube.com/... or another reference link">
    <label>Optional photo / screenshot</label><input id="learnImage" type="file" accept="image/*" class="form-input" onchange="addImage(this,'learnImageValue')"><input id="learnImageValue" type="hidden">
    <img id="learnImageValuePreview" class="photo-preview" style="display:none">
    <div class="form-actions"><button class="mini-btn" onclick="closeModal()">Cancel</button><button class="primary-btn" onclick="saveMyLearning()">Save Learning ✓</button></div>`);
}
async function saveMyLearning(){
  const title=document.getElementById("learnTitle")?.value.trim();
  if(!title){alert("Please enter what you learned.");return;}
  data.myLearnings=data.myLearnings||[];
  let image=document.getElementById("learnImageValue").value||"";
  if(pendingImages.learnImageValue){
    if(!cloudUser){alert("Please sign in to save photos to cloud storage.");return;}
    try{setSyncStatus("☁️ Uploading photo…","saving");image=await uploadImageFile(pendingImages.learnImageValue,"learning");delete pendingImages.learnImageValue;}catch(e){alert("The photo could not be uploaded. Please try again.");return;}
  }
  const link=document.getElementById("learnLink")?.value.trim()||"";
  if(link){try{new URL(link);}catch(e){alert("Please enter a valid link starting with http:// or https://");return;}}
  data.myLearnings.unshift({title,category:document.getElementById("learnCategory").value,status:document.getElementById("learnStatus").value,notes:document.getElementById("learnNotes").value,link,image,date:new Date().toLocaleDateString()});
  if(saveData()){closeModal();renderLessons();toast("Learning saved ✓");}
}
function deleteMyLearning(i){if(confirm("Delete this learning note?")){data.myLearnings.splice(i,1);if(saveData())renderLessons();}}
function editMyLearning(i){
  const x=data.myLearnings?.[i]; if(!x)return;
  pendingImages.editLearnImageValue=null;
  modal(`<h2>✏️ Edit What I Learned 🌱</h2>
    <label>What did you learn?</label><input id="editLearnTitle" class="form-input" value="${esc(x.title||"")}" placeholder="e.g. How to make a magic ring">
    <label>Category</label><select id="editLearnCategory" class="form-input"><option ${x.category==="Stitch"?"selected":""}>Stitch</option><option ${x.category==="Technique"?"selected":""}>Technique</option><option ${x.category==="Pattern Reading"?"selected":""}>Pattern Reading</option><option ${x.category==="Yarn & Hook"?"selected":""}>Yarn & Hook</option><option ${x.category==="Tip / Discovery"?"selected":""}>Tip / Discovery</option><option ${x.category==="Other"?"selected":""}>Other</option></select>
    <label>Status</label><select id="editLearnStatus" class="form-input"><option ${x.status==="Learned"?"selected":""}>Learned</option><option ${x.status==="Practicing"?"selected":""}>Practicing</option><option ${x.status==="Need to Practice"?"selected":""}>Need to Practice</option></select>
    <label>Notes</label><textarea id="editLearnNotes" class="form-textarea" placeholder="Write what you learned, steps, tips, or reminders...">${esc(x.notes||"")}</textarea>
    <label>Attach link</label><input id="editLearnLink" type="url" class="form-input" value="${esc(x.link||"")}" placeholder="https://youtube.com/... or another reference link">
    <label>Optional photo / screenshot</label><input id="editLearnImage" type="file" accept="image/*" class="form-input" onchange="addImage(this,'editLearnImageValue')"><input id="editLearnImageValue" type="hidden" value="${esc(x.image||"")}">
    ${x.image?`<img id="editLearnImageValuePreview" class="photo-preview" src="${esc(x.image)}" alt="Current learning image">`:`<img id="editLearnImageValuePreview" class="photo-preview" style="display:none">`}
    <div class="form-actions"><button class="mini-btn" onclick="closeModal()">Cancel</button><button class="primary-btn" onclick="saveMyLearningEdit(${i})">Save Changes ✓</button></div>`);
}
async function saveMyLearningEdit(i){
  const x=data.myLearnings?.[i]; if(!x)return;
  const title=document.getElementById("editLearnTitle")?.value.trim();
  if(!title){alert("Please enter what you learned.");return;}
  const link=document.getElementById("editLearnLink")?.value.trim()||"";
  if(link){try{new URL(link);}catch(e){alert("Please enter a valid link starting with http:// or https://");return;}}
  let image=document.getElementById("editLearnImageValue")?.value||x.image||"";
  if(pendingImages.editLearnImageValue){
    if(!cloudUser){alert("Please sign in to save photos to cloud storage.");return;}
    try{setSyncStatus("☁️ Uploading photo…","saving");image=await uploadImageFile(pendingImages.editLearnImageValue,"learning");delete pendingImages.editLearnImageValue;}catch(e){alert("The photo could not be uploaded. Please try again.");return;}
  }
  x.title=title;
  x.category=document.getElementById("editLearnCategory").value;
  x.status=document.getElementById("editLearnStatus").value;
  x.notes=document.getElementById("editLearnNotes").value;
  x.link=link;
  x.image=image;
  if(saveData()){closeModal();renderLessons();toast("Learning updated ✓");}
}
function renderStitches(q=""){const a=stitches.filter(s=>s.join(" ").toLowerCase().includes(q.toLowerCase()));document.getElementById("stitchList").innerHTML=a.map(s=>`<div class="item"><h3>${esc(s[0])} — ${esc(s[1])}</h3><p>${esc(s[2])}</p></div>`).join("")||'<div class="empty">No stitch found.</div>'}
function renderCategories(){const sel=document.getElementById("categoryFilter"),old=sel.value||"All";sel.innerHTML='<option value="All">All Categories</option>'+data.categories.map(c=>`<option>${esc(c)}</option>`).join("");sel.value=data.categories.includes(old)?old:"All"}
function renderAll(){renderCategories();renderProjects();renderPatterns();renderYarn();renderLessons();renderStitches(document.getElementById("stitchSearch")?.value||"")}
function lesson(n){const l=lessons.find(x=>x[0]===n);modal(`<span class="pill">LESSON ${l[0]}</span><h2>${l[3]} ${esc(l[1])}</h2><p>${esc(l[2])}</p><div class="card" style="padding:16px;margin-top:14px"><strong>Practice</strong><p>Grab your hook and some scrap yarn. Practice slowly and count your stitches.</p></div><div class="form-actions"><button class="primary-btn" onclick="closeModal()">Got it ✓</button></div>`)}
function removeItem(type,i){if(confirm("Delete this item?")){data[type].splice(i,1);save()}}
function addImage(input,targetId){
  const f=input.files?.[0];if(!f)return;
  pendingImages[targetId]=f;
  const url=URL.createObjectURL(f);
  const hidden=document.getElementById(targetId);if(hidden)hidden.value="";
  const preview=document.getElementById(targetId+"Preview");
  if(preview){preview.src=url;preview.style.display="block";preview.onload=()=>URL.revokeObjectURL(url);}
}
function categoryOptions(selected=""){return data.categories.map(c=>`<option ${c===selected?"selected":""}>${esc(c)}</option>`).join("")}
document.getElementById("addPatternBtn").onclick=()=>newPattern();
function newPattern(){modal(`<h2>New Pattern 🧶</h2><label>Pattern name</label><input id="pName" class="form-input" placeholder="e.g. Bunny Amigurumi"><label>Category</label><div class="source-row"><select id="pCat" class="form-input">${categoryOptions("Amigurumi")}</select><button class="mini-btn" onclick="addCategory()">＋ Category</button></div><label>Source / YouTube URL</label><input id="pSource" class="form-input" placeholder="Paste YouTube link"><label>Difficulty</label><input id="pDiff" class="form-input" placeholder="Beginner"><label>Hook</label><input id="pHook" class="form-input" placeholder="3.0 mm"><label>Yarn</label><input id="pYarn" class="form-input" placeholder="Cotton yarn"><label>Cover photo</label><input type="hidden" id="pCover"><input type="file" accept="image/*" class="form-input" onchange="addImage(this,'pCover')"><img id="pCoverPreview" class="photo-preview" style="display:none"><div class="form-actions"><button class="primary-btn" onclick="createPattern()">Create Pattern</button></div>`)}
function addCategory(){const n=prompt("New category name:");if(n&&n.trim()&&!data.categories.includes(n.trim())){data.categories.push(n.trim());save();newPattern()}}
async function createPattern(){
  let cover=document.getElementById("pCover").value||"";
  if(pendingImages.pCover){
    if(!cloudUser){alert("Please sign in to save a cover photo to cloud storage.");return;}
    try{setSyncStatus("☁️ Uploading cover photo…","saving");cover=await uploadImageFile(pendingImages.pCover,"pattern-cover");delete pendingImages.pCover;}catch(e){alert("The cover photo could not be uploaded. Please try again.");return;}
  }
  const p={id:Date.now().toString(),name:document.getElementById("pName").value||"Untitled Pattern",category:document.getElementById("pCat").value,source:document.getElementById("pSource").value,difficulty:document.getElementById("pDiff").value||"Beginner",hook:document.getElementById("pHook").value,yarn:document.getElementById("pYarn").value,cover,notes:"",rounds:[]};
  data.patterns.unshift(p);save();closeModal();viewPattern(p.id)
}
function deletePattern(id){
  const p=data.patterns.find(x=>x.id===id); if(!p)return;
  const linked=data.projects.filter(x=>x.patternId===id).length;
  const msg=linked?`Delete “${p.name}” and its rounds? ${linked} linked project${linked>1?"s":""} will be unlinked. This cannot be undone.`:`Delete “${p.name}” and its rounds? This cannot be undone.`;
  if(!confirm(msg))return;
  data.projects.forEach(project=>{if(project.patternId===id)project.patternId=null;});
  data.patterns=data.patterns.filter(x=>x.id!==id);
  if(saveData()){renderAll();toast("Pattern deleted ✓");}
}
function viewPattern(id,projectId=null){const p=data.patterns.find(x=>x.id===id);if(!p)return;modal(patternEditor(p,projectId,false))}
function toggleRoundDone(patternId,index,checked){
  const p=data.patterns.find(x=>x.id===patternId);
  if(!p || !p.rounds?.[index]) return;
  p.rounds[index].done=!!checked;
  syncLinkedProjectProgress(p);
  if(saveData()){
    setTimeout(()=>viewPattern(patternId),80);
  }
}
function editPattern(id){
  editingPatternId = id;const p=data.patterns.find(x=>x.id===id);if(!p)return;modal(patternEditor(p,null,true))}
function patternEditor(p,projectId=null,editMode=true){
 const rounds=p.rounds||[], last=getLastRound(p);
 const linked=data.projects.filter(x=>x.patternId===p.id);
 const roundContent=rounds.map((r,i)=>roundHTML(r,i,last,editMode,p.id)).join("");
 return `<span class="pill">${esc(p.category)}</span><h2>${esc(p.name)}</h2>
 <div class="meta">${esc(p.difficulty)} · ${esc(p.hook||"")} · ${esc(p.yarn||"")}</div>
 ${p.cover?`<img class="pattern-cover" src="${p.cover}">`:""}
 ${editMode?`<div class="item" style="margin-top:12px"><strong>✏️ Pattern Details</strong>
   <label>Pattern name</label><input id="editPatternName" class="form-input" value="${esc(p.name||"")}">
   <label>Category</label><select id="editPatternCategory" class="form-input">${categoryOptions(p.category)}</select>
   <label>Difficulty</label><input id="editPatternDifficulty" class="form-input" value="${esc(p.difficulty||"")}" placeholder="Beginner">
   <label>Hook</label><input id="editPatternHook" class="form-input" value="${esc(p.hook||"")}" placeholder="3.0 mm">
   <label>Yarn</label><input id="editPatternYarn" class="form-input" value="${esc(p.yarn||"")}" placeholder="Cotton yarn">
   <label>Cover photo</label><input type="hidden" id="editPatternCover" value="${esc(p.cover||"")}"><input type="file" accept="image/*" class="form-input" onchange="addImage(this,'editPatternCover')">
   ${p.cover?`<img id="editPatternCoverPreview" class="photo-preview" src="${esc(p.cover)}" alt="Current cover photo">`:`<img id="editPatternCoverPreview" class="photo-preview" style="display:none">`}
   <button class="primary-btn full" onclick="savePatternDetails('${p.id}')">Save Pattern Details ✓</button>
 </div>`:""}
 <div class="item" style="margin-top:12px">
   <strong>🎥 Tutorial</strong>
   ${editMode?`<input id="editSource" class="form-input" value="${esc(p.source||"")}" placeholder="YouTube URL"><textarea id="editNotes" class="form-textarea" placeholder="My notes...">${esc(p.notes||"")}</textarea>`:`<div class="linked-pattern">${p.source?`<a href="${esc(p.source)}" target="_blank" rel="noopener">▶ Open YouTube Tutorial</a>`:"No tutorial link saved."}</div>${p.notes?`<p style="margin-top:10px">${esc(p.notes)}</p>`:""}`}
   ${editMode?`<button class="primary-btn full" onclick="savePatternInfo('${p.id}')">Save Tutorial & Notes</button>`:""}
 </div>
 <h3 style="margin-top:18px">📝 Rounds / Steps</h3>
 <div class="meta">Mark completed rounds in View Pattern. The <strong>thick border and LAST DONE</strong> marker appear on the latest completed round.</div>
 <div id="rounds">${roundContent}</div>
 ${editMode?`<button class="primary-btn full" onclick="addRound('${p.id}')">＋ Add Round / Step</button>`:""}
 ${linked.length?`<div class="item linked-project-box" style="margin-top:14px"><strong>📋 Linked Projects</strong><div class="progress" style="margin-top:10px"><div class="bar" style="width:${getPatternProgress(p)}%"></div></div><div class="meta"><strong>${getPatternProgress(p)}%</strong> complete${p.rounds?.length?` · Last completed: ${getLastRound(p)>=0?`R${getLastRound(p)+1}`:"None"} of R${p.rounds.length}`:""}</div>${linked.map(x=>`<div class="linked-pattern">${esc(x.name)} · ${getPatternProgress(p)}%</div>`).join("")}</div>`:""}
 ${editMode?`<div class="form-actions"><button class="mini-btn" onclick="closeModal()">Close</button><button class="primary-btn" onclick="saveRounds('${p.id}')">Save Rounds ✓</button></div>`:`<div class="form-actions"><button class="mini-btn" onclick="closeModal()">Close</button><button class="primary-btn" onclick="editPattern('${p.id}')">✏️ Edit Pattern</button></div>`}`
}
function roundHTML(r,i,last,editMode,pIdForRound=""){
  const image = r.image || r.img || "";
  const text = r.text || r.instructions || "";
  const done = !!r.done;
  if(editMode){
    return `
      <div class="round-card edit-round-card" data-round-index="${i}">
        <div class="round-head">
          <strong>R${i+1}</strong>
        </div>
        <div class="round-editor">
          <label>📝 Instructions / Notes</label>
          <textarea class="round-text" data-round="${i}" placeholder="Enter the instructions for Round ${i+1}...">${esc(text)}</textarea>

          <label>🖼️ Round Image / Tutorial Screenshot</label>
          <input type="hidden" class="round-image-value" value="${esc(image)}">
          ${image ? `<img class="round-image-preview" src="${image}" alt="Round ${i+1} image">` : '<div class="muted round-no-image">No image added yet.</div>'}
          <div class="image-actions">
            <input type="file" accept="image/*" class="round-image-input" onchange="previewRoundImage(this)">
            ${image ? `<button type="button" class="secondary small" onclick="removeRoundImage(${i})">Remove Image</button>` : ''}
          </div>

        </div>
      </div>`;
  }
  return `
    <div class="round-card view-round-card ${done && i===last ? "last-done" : ""}">
      <div class="round-head">
        <strong>R${i+1}</strong>
        <label class="view-round-complete">
          <input type="checkbox" class="round-done-view" ${done ? "checked" : ""} onchange="toggleRoundDone('${pIdForRound ?? ""}',${i},this.checked)">
          <span>Done</span>
        </label>
        ${done && i===last ? '<span class="last-badge">LAST DONE</span>' : ''}
      </div>
      ${text ? `<div class="round-text-display">${nl2br(esc(text))}</div>` : ''}
      ${image ? `<img class="round-image-preview" src="${image}" alt="Round ${i+1} image" title="Tap to enlarge" onclick="openRoundImageViewer(this.src,this.alt)">` : ''}
    </div>`;
}

function openRoundImageViewer(src, alt="Tutorial image") {
  if(!src) return;
  const existing=document.getElementById("roundImageViewer");
  if(existing) existing.remove();

  const overlay=document.createElement("div");
  overlay.id="roundImageViewer";
  overlay.setAttribute("role","dialog");
  overlay.setAttribute("aria-label","Enlarged tutorial image");
  overlay.style.cssText="position:fixed;inset:0;z-index:99999;background:rgba(40,30,28,.92);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;cursor:zoom-out;";

  const img=document.createElement("img");
  img.src=src;
  img.alt=alt;
  img.style.cssText="max-width:100%;max-height:92vh;width:auto;height:auto;object-fit:contain;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);cursor:default;background:#fff;";

  const close=document.createElement("button");
  close.type="button";
  close.textContent="✕";
  close.setAttribute("aria-label","Close image");
  close.style.cssText="position:absolute;top:14px;right:14px;width:46px;height:46px;border:0;border-radius:50%;background:#fff;color:#5e4b47;font-size:25px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);";

  const closeViewer=()=>overlay.remove();
  close.onclick=closeViewer;
  overlay.onclick=(e)=>{if(e.target===overlay) closeViewer();};
  document.addEventListener("keydown",function onKey(e){
    if(e.key==="Escape"){closeViewer();document.removeEventListener("keydown",onKey);}
  });

  overlay.appendChild(img);
  overlay.appendChild(close);
  document.body.appendChild(overlay);
}

function addRound(id){
  const p=data.patterns.find(x=>x.id===id);
  if(!p)return;
  // Save the currently visible editor first so newly added rounds do not overwrite unsaved work.
  collectRoundEditor(p);
  p.rounds=p.rounds||[];
  p.rounds.push({text:"",image:"",done:false});
  saveData();
  editPattern(id);
  setTimeout(()=>{const cards=document.querySelectorAll("#rounds .round-card");cards[cards.length-1]?.scrollIntoView({behavior:"smooth",block:"center"})},50);
}
function previewRoundImage(input){
  const card=input.closest(".round-card");
  const f=input.files?.[0];
  if(!f || !card)return;
  card._pendingImageFile=f;
  const url=URL.createObjectURL(f);
  const hidden=card.querySelector(".round-image-value");if(hidden)hidden.value="";
  let img=card.querySelector(".round-image-preview");
  if(!img){img=document.createElement("img");img.className="round-image-preview";card.querySelector(".image-actions").before(img);}
  img.src=url;img.style.display="block";img.onload=()=>URL.revokeObjectURL(url);
  const empty=card.querySelector(".round-no-image");if(empty)empty.style.display="none";
  card.dataset.imageChanged="1";
}
function collectRoundEditor(p){
  const cards=[...document.querySelectorAll("#rounds .round-card")];
  if(!cards.length)return;
  p.rounds=cards.map((c,i)=>({
    // Completion is controlled in View Pattern, so preserve the existing done state while editing.
    done:!!p.rounds?.[i]?.done,
    text:c.querySelector(".round-text")?.value||"",
    image:c.querySelector(".round-image-value")?.value||""
  }));
}
async function saveRounds(id){
  const p=data.patterns.find(x=>x.id===id);
  if(!p)return;
  const cards=[...document.querySelectorAll("#rounds .round-card")];
  for(let i=0;i<cards.length;i++){
    const card=cards[i], file=card._pendingImageFile;
    if(file){
      if(!cloudUser){alert("Please sign in to save round photos to cloud storage.");return;}
      try{setSyncStatus(`☁️ Uploading round ${i+1}…`,"saving");const url=await uploadImageFile(file,"round");const hidden=card.querySelector(".round-image-value");if(hidden)hidden.value=url;delete card._pendingImageFile;}catch(e){alert(`Round ${i+1} photo could not be uploaded. Please try again.`);return;}
    }
  }
  collectRoundEditor(p);
  syncLinkedProjectProgress(p);
  if(saveData()){
    toast("Rounds / steps saved ✓");
    // Return to the clean View Pattern screen so the saved text, image, and LAST DONE row are immediately visible.
    setTimeout(()=>viewPattern(id),180);
  }
}

async function savePatternDetails(id){
 const p=data.patterns.find(x=>x.id===id);if(!p)return;
 p.name=document.getElementById("editPatternName").value.trim()||"Untitled Pattern";
 p.category=document.getElementById("editPatternCategory").value;
 p.difficulty=document.getElementById("editPatternDifficulty").value.trim()||"Beginner";
 p.hook=document.getElementById("editPatternHook").value.trim();
 p.yarn=document.getElementById("editPatternYarn").value.trim();
 let cover=document.getElementById("editPatternCover").value||p.cover||"";
 if(pendingImages.editPatternCover){
   if(!cloudUser){alert("Please sign in to save a cover photo to cloud storage.");return;}
   try{setSyncStatus("☁️ Uploading cover photo…","saving");cover=await uploadImageFile(pendingImages.editPatternCover,"pattern-cover");delete pendingImages.editPatternCover;}catch(e){alert("The cover photo could not be uploaded. Please try again.");return;}
 }
 p.cover=cover;
 if(saveData()){toast("Pattern details saved ✓");setTimeout(()=>viewPattern(id),150);}
}
function savePatternInfo(id){const p=data.patterns.find(x=>x.id===id);p.source=document.getElementById("editSource").value;p.notes=document.getElementById("editNotes").value;save();viewPattern(id)}
document.getElementById("categoryFilter").addEventListener("change",renderPatterns);
document.getElementById("stitchSearch").addEventListener("input",e=>renderStitches(e.target.value));
function projectPatternOptions(selected=""){return `<option value="">No pattern linked</option>`+data.patterns.map(p=>`<option value="${p.id}" ${p.id===selected?"selected":""}>${esc(p.name)} — ${esc(p.category)}</option>`).join("")}
document.getElementById("addProjectBtn").onclick=()=>modal(`<h2>New Project 📋</h2><input id="fName" class="form-input" placeholder="Project name"><label>Link to pattern</label><select id="fPattern" class="form-input">${projectPatternOptions()}</select><div class="meta">If you link a pattern, progress is calculated automatically from the last completed round.</div><input id="fProgress" type="number" min="0" max="100" class="form-input" placeholder="Manual progress % (only for unlinked projects)"><input id="fStatus" class="form-input" placeholder="Status (WIP, Planned, Done)"><textarea id="fNotes" class="form-textarea" placeholder="Notes"></textarea><div class="form-actions"><button class="primary-btn" onclick="addProject()">Save Project</button></div>`);
function addProject(){data.projects.unshift({name:document.getElementById("fName").value||"Untitled Project",patternId:document.getElementById("fPattern").value||null,progress:Number(document.getElementById("fProgress").value)||0,status:document.getElementById("fStatus").value||"WIP",notes:document.getElementById("fNotes").value});save();closeModal()}
function editProject(i){const p=data.projects[i];const pat=p.patternId?data.patterns.find(x=>x.id===p.patternId):null;const progress=pat?getPatternProgress(pat):Math.min(100,Math.max(0,Number(p.progress)||0));modal(`<h2>Edit Project 📋</h2><input id="efName" class="form-input" value="${esc(p.name)}"><label>Linked pattern</label><select id="efPattern" class="form-input">${projectPatternOptions(p.patternId||"")}</select><div class="meta" id="efProgressNote">${pat?`Progress is automatic: ${progress}% based on the last completed round.`:"Progress is manual because no pattern is linked."}</div><input id="efProgress" type="number" min="0" max="100" class="form-input" value="${progress}" ${pat?"readonly":""}><input id="efStatus" class="form-input" value="${esc(p.status||"WIP")}"><textarea id="efNotes" class="form-textarea">${esc(p.notes||"")}</textarea><div class="form-actions"><button class="primary-btn" onclick="saveProject(${i})">Save Changes</button></div>`)}
function saveProject(i){const p=data.projects[i];p.name=document.getElementById("efName").value||"Untitled Project";p.patternId=document.getElementById("efPattern").value||null;const pat=p.patternId?data.patterns.find(x=>x.id===p.patternId):null;p.progress=pat?getPatternProgress(pat):Math.min(100,Math.max(0,Number(document.getElementById("efProgress").value)||0));p.status=document.getElementById("efStatus").value||"WIP";p.notes=document.getElementById("efNotes").value;save();closeModal()}
document.getElementById("addYarnBtn").onclick=()=>modal(`<h2>New Yarn 🧵</h2><label>Brand / yarn name</label><input id="yName" class="form-input" placeholder="e.g. Himalaya Dolphin Baby"><label>Color</label><input id="yColor" class="form-input" placeholder="e.g. Pink"><label>Weight</label><input id="yWeight" class="form-input" placeholder="e.g. DK, worsted"><label>Amount</label><input id="yAmount" class="form-input" placeholder="e.g. 100 g / 1 ball"><div class="form-actions"><button class="mini-btn" onclick="closeModal()">Cancel</button><button class="primary-btn" onclick="addYarn()">Save Yarn ✓</button></div>`);
function addYarn(){const name=document.getElementById("yName").value.trim()||"Unnamed Yarn";data.yarn.unshift({name,color:document.getElementById("yColor").value.trim(),weight:document.getElementById("yWeight").value.trim(),amount:document.getElementById("yAmount").value.trim()});if(saveData()){closeModal();renderYarn();toast("Yarn added ✓")}}
function editYarn(i){
  const y=data.yarn?.[i];if(!y)return;
  modal(`<h2>✏️ Edit Yarn 🧵</h2><label>Brand / yarn name</label><input id="eyName" class="form-input" value="${esc(y.name||"")}" placeholder="e.g. Himalaya Dolphin Baby"><label>Color</label><input id="eyColor" class="form-input" value="${esc(y.color||"")}" placeholder="e.g. Pink"><label>Weight</label><input id="eyWeight" class="form-input" value="${esc(y.weight||"")}" placeholder="e.g. DK, worsted"><label>Amount</label><input id="eyAmount" class="form-input" value="${esc(y.amount||"")}" placeholder="e.g. 100 g / 1 ball"><div class="form-actions"><button class="mini-btn" onclick="closeModal()">Cancel</button><button class="primary-btn" onclick="saveYarnEdit(${i})">Save Changes ✓</button></div>`);
}
function saveYarnEdit(i){
  const y=data.yarn?.[i];if(!y)return;
  y.name=document.getElementById("eyName").value.trim()||"Unnamed Yarn";
  y.color=document.getElementById("eyColor").value.trim();
  y.weight=document.getElementById("eyWeight").value.trim();
  y.amount=document.getElementById("eyAmount").value.trim();
  if(saveData()){closeModal();renderYarn();toast("Yarn updated ✓")}
}
document.getElementById("tipBtn").onclick=()=>{document.getElementById("tipText").textContent=tips[Math.floor(Math.random()*tips.length)];go("home")};

function setupAuthUI(){
  const submit=document.getElementById("authSubmit"), sw=document.getElementById("authSwitch"), forgot=document.getElementById("authForgot");
  let signup=false;
  function update(){
    document.getElementById("authTitle").textContent=signup?"Create your Crochet Buddy account 🧶":"Welcome back 💗";
    document.getElementById("authSubtitle").textContent=signup?"Create an account so your crochet journal can sync across devices.":"Log in to keep your crochet journal synced across your devices.";
    submit.textContent=signup?"Create Account":"Log In";
    sw.textContent=signup?"Already have an account? Log in":"Create a new account";
  }
  sw?.addEventListener("click",()=>{signup=!signup;setAuthMessage("");update()});
  submit?.addEventListener("click",async()=>{
    const email=document.getElementById("authEmail").value.trim(), password=document.getElementById("authPassword").value;
    if(!email||!password){setAuthMessage("Please enter your email and password.");return}
    if(!supabaseClient){setAuthMessage("Cloud connection is unavailable.");return}
    submit.disabled=true;setAuthMessage("Connecting…");
    let result;
    if(signup) result=await supabaseClient.auth.signUp({email,password});
    else result=await supabaseClient.auth.signInWithPassword({email,password});
    submit.disabled=false;
    if(result.error){setAuthMessage(result.error.message);return}
    if(signup && !result.data.session){setAuthMessage("Account created! Check your email to confirm your account, then log in.",true);return}
    if(result.data.session){cloudUser=result.data.user;showAuthScreen(false);await loadCloudData(cloudUser);document.getElementById("lockScreen")?.classList.remove("hidden");}
  });
  forgot?.addEventListener("click",async()=>{
    const email=document.getElementById("authEmail").value.trim();
    if(!email){setAuthMessage("Enter your email first, then tap Forgot password.");return}
    const redirect=window.location.origin+window.location.pathname;
    const {error}=await supabaseClient.auth.resetPasswordForEmail(email,{redirectTo:redirect});
    setAuthMessage(error?error.message:"Password reset email sent. Check your inbox.",!error);
  });
  update();
}
async function initCloud(){
  setupAuthUI();
  if(!supabaseClient){showAuthScreen(true);setSyncStatus("☁️ Cloud unavailable","error");return;}
  const {data:{session}}=await supabaseClient.auth.getSession();
  if(session?.user){cloudUser=session.user;showAuthScreen(false);await loadCloudData(cloudUser);applyTheme();}
  else {setSyncStatus("☁️ Sign in to sync");showAuthScreen(true);}
  supabaseClient.auth.onAuthStateChange(async(_event,session)=>{
    if(session?.user){cloudUser=session.user;showAuthScreen(false);if(!cloudReady)await loadCloudData(cloudUser);}
    else {cloudUser=null;cloudReady=false;showAuthScreen(true);}
  });
}

applyTheme();
renderAll();
removeUnexpectedHomeImages();
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
initCloud();


/* Privacy PIN lock — 4 digits */
const PIN_KEY="crochetBuddyPinV1";
const DEFAULT_PIN="0705";
const lockScreen=document.getElementById("lockScreen");
const pinInput=document.getElementById("pinInput");
const pinDots=document.querySelectorAll("#pinDots span");
const pinMessage=document.getElementById("pinMessage");
const changePinBtn=document.getElementById("changePinBtn");
const pinPrompt=document.getElementById("pinPrompt");
let storedPin=localStorage.getItem(PIN_KEY)||DEFAULT_PIN;
let pinMode="unlock";
let pinFirst="";
function updateDots(){const v=pinInput.value;pinDots.forEach((d,i)=>d.classList.toggle("filled",i<v.length))}
function showPinMessage(t){pinMessage.textContent=t}
function unlock(){
 const value=pinInput.value;
 if(pinMode==="set"){
   if(value.length<4){showPinMessage("Enter all 4 digits.");return}
   if(!pinFirst){pinFirst=value;pinInput.value="";updateDots();showPinMessage("Enter the same PIN again.");return}
   if(value===pinFirst){storedPin=value;localStorage.setItem(PIN_KEY,value);pinMode="unlock";pinFirst="";pinInput.value="";updateDots();showPinMessage("PIN saved ✓");pinPrompt.textContent="Your PIN has been changed.";setTimeout(()=>{showPinMessage("");pinPrompt.textContent="Enter your 4-digit PIN to open your crochet notebook."},900);return}
   pinFirst="";pinInput.value="";updateDots();showPinMessage("PINs did not match. Try again.");return
 }
 if(value===storedPin){pinInput.value="";updateDots();showPinMessage("");lockScreen.classList.add("hidden");return}
 pinInput.value="";updateDots();showPinMessage("Incorrect PIN.");const c=document.querySelector(".lock-card");c.classList.remove("shake");void c.offsetWidth;c.classList.add("shake");
}
function pressKey(k){
 if(k==="clear"){pinInput.value=pinInput.value.slice(0,-1);updateDots();return}
 if(k==="enter"){unlock();return}
 if(/^\d$/.test(k)&&pinInput.value.length<4){pinInput.value+=k;updateDots();if(pinInput.value.length===4)setTimeout(unlock,100)}
}
document.querySelectorAll(".key").forEach(b=>b.addEventListener("click",()=>pressKey(b.dataset.key)));
pinInput.addEventListener("input",()=>{pinInput.value=pinInput.value.replace(/\D/g,"").slice(0,4);updateDots();if(pinInput.value.length===4)setTimeout(unlock,100)});
pinInput.addEventListener("keydown",e=>{if(e.key==="Enter")unlock();if(e.key==="Backspace")setTimeout(updateDots,0)});
changePinBtn.addEventListener("click",()=>{pinMode="set";pinFirst="";pinInput.value="";updateDots();pinPrompt.textContent="Enter a new 4-digit PIN.";showPinMessage("");});
lockScreen.addEventListener("click",e=>{if(e.target===lockScreen)pinInput.focus()});
setTimeout(()=>pinInput.focus(),200);
document.getElementById("lockBtn").addEventListener("click",()=>{lockScreen.classList.remove("hidden");pinInput.value="";updateDots();showPinMessage("");pinMode="unlock";pinInput.focus()});
const lockLogoutBtn=document.getElementById("lockLogoutBtn");
lockLogoutBtn?.addEventListener("click",async()=>{
  if(confirm("Log out of your Crochet Buddy cloud account? Your cloud data will stay saved.")){
    await logoutCloud();
  }
});
function updateLockAccount(){
  const el=document.getElementById("lockAccountText");
  if(el) el.textContent=cloudUser?.email ? "☁️ Signed in as " + cloudUser.email : "☁️ Not signed in";
}
setInterval(updateLockAccount,1000);
updateLockAccount();


const profileButton=document.getElementById("profileBtn");
if(profileButton) profileButton.addEventListener("click",openProfile);
