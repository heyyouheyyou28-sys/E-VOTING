const express=require("express");
const cookieParser=require("cookie-parser");
const rateLimit=require("express-rate-limit");
const Database=require("better-sqlite3");
const crypto=require("crypto");
const path=require("path");

const app=express();
const db=new Database("election.db");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const PORT=process.env.PORT||3000;
const SCHOOL=process.env.SCHOOL_NAME||"School Election";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"change-this-before-deployment";
const SESSION_SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex");

app.use(express.json({limit:"100kb"}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,"public")));
app.use(rateLimit({windowMs:15*60*1000,max:300,standardHeaders:true,legacyHeaders:false}));

db.exec(`
CREATE TABLE IF NOT EXISTS voters(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 student_id TEXT UNIQUE NOT NULL,
 name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 has_voted INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS positions(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 max_choices INTEGER NOT NULL DEFAULT 1,
 sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS candidates(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 position_id INTEGER NOT NULL,
 name TEXT NOT NULL,
 bio TEXT DEFAULT '',
 photo_url TEXT DEFAULT '',
 FOREIGN KEY(position_id) REFERENCES positions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS votes(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 voter_id INTEGER NOT NULL,
 position_id INTEGER NOT NULL,
 candidate_id INTEGER NOT NULL,
 cast_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(voter_id) REFERENCES voters(id),
 FOREIGN KEY(position_id) REFERENCES positions(id),
 FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_vote_per_position ON votes(voter_id,position_id);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor TEXT NOT NULL,
 action TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const getSetting=k=>db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value;
const setSetting=(k,v)=>db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,String(v));
if(!getSetting("election_open")) setSetting("election_open","0");
if(!getSetting("results_published")) setSetting("results_published","0");
if(!getSetting("school_name")) setSetting("school_name",SCHOOL);

function hash(p){return crypto.createHash("sha256").update(p).digest("hex")}
function sign(value){
 const sig=crypto.createHmac("sha256",SESSION_SECRET).update(value).digest("hex");
 return value+"."+sig;
}
function verify(token){
 try{
  const [value,sig]=token.split(".");
  const expected=crypto.createHmac("sha256",SESSION_SECRET).update(value).digest("hex");
  if(!value||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return null;
  return value;
 }catch{return null}
}
function voter(req){
 const v=verify(req.cookies.voter_session||"");
 if(!v) return null;
 return db.prepare("SELECT id,student_id,name,has_voted FROM voters WHERE id=?").get(Number(v));
}
function admin(req){return verify(req.cookies.admin_session||"")==="admin"}

function audit(actor,action){db.prepare("INSERT INTO audit_logs(actor,action) VALUES(?,?)").run(actor,action)}

app.get("/api/config",(req,res)=>res.json({
 school_name:getSetting("school_name"), election_open:getSetting("election_open")==="1",
 results_published:getSetting("results_published")==="1"
}));

app.post("/api/login",(req,res)=>{
 const {student_id,password}=req.body||{};
 const row=db.prepare("SELECT * FROM voters WHERE student_id=?").get(String(student_id||"").trim());
 if(!row||row.password_hash!==hash(String(password||""))) return res.status(401).json({error:"Invalid student ID or password"});
 res.cookie("voter_session",sign(String(row.id)),{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000});
 res.json({name:row.name,student_id:row.student_id,has_voted:!!row.has_voted});
});

app.post("/api/logout",(req,res)=>{res.clearCookie("voter_session");res.clearCookie("admin_session");res.json({ok:true})});

app.get("/api/ballot",(req,res)=>{
 const v=voter(req);
 if(!v) return res.status(401).json({error:"Login required"});
 if(getSetting("election_open")!=="1") return res.status(403).json({error:"The election is currently closed"});
 const positions=db.prepare("SELECT * FROM positions ORDER BY sort_order,id").all();
 const out=positions.map(p=>({...p,candidates:db.prepare("SELECT id,name,bio,photo_url FROM candidates WHERE position_id=? ORDER BY id").all(p.id)}));
 res.json({voter:v,positions:out});
});

app.post("/api/vote",(req,res)=>{
 const v=voter(req);
 if(!v) return res.status(401).json({error:"Login required"});
 if(getSetting("election_open")!=="1") return res.status(403).json({error:"Election is closed"});
 if(v.has_voted) return res.status(409).json({error:"This voter has already submitted a ballot"});
 const selections=req.body?.selections;
 if(!selections||typeof selections!=="object") return res.status(400).json({error:"Invalid ballot"});
 const positions=db.prepare("SELECT id,max_choices FROM positions").all();
 const tx=db.transaction(()=>{
  for(const p of positions){
   const ids=Array.isArray(selections[p.id])?selections[p.id]:[];
   if(ids.length!==p.max_choices) throw new Error(`Select exactly ${p.max_choices} candidate(s) for every position`);
   for(const cid of ids){
    const c=db.prepare("SELECT id FROM candidates WHERE id=? AND position_id=?").get(cid,p.id);
    if(!c) throw new Error("Invalid candidate selection");
    db.prepare("INSERT INTO votes(voter_id,position_id,candidate_id) VALUES(?,?,?)").run(v.id,p.id,cid);
   }
  }
  db.prepare("UPDATE voters SET has_voted=1 WHERE id=?").run(v.id);
  audit("voter:"+v.student_id,"Ballot submitted");
 });
 try{tx();res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}
});

app.get("/api/results",(req,res)=>{
 if(getSetting("results_published")!=="1" && !admin(req)) return res.status(403).json({error:"Results are not published"});
 const positions=db.prepare("SELECT * FROM positions ORDER BY sort_order,id").all();
 const results=positions.map(p=>({...p,candidates:db.prepare(`
 SELECT c.id,c.name,COUNT(v.id) votes FROM candidates c
 LEFT JOIN votes v ON v.candidate_id=c.id WHERE c.position_id=? GROUP BY c.id ORDER BY votes DESC,c.name
 `).all(p.id)}));
 const total=db.prepare("SELECT COUNT(*) n FROM voters").get().n;
 const voted=db.prepare("SELECT COUNT(*) n FROM voters WHERE has_voted=1").get().n;
 res.json({results,total,voted,turnout:total?Math.round(voted*1000/total)/10:0});
});

function adminOnly(req,res,next){if(!admin(req))return res.status(401).json({error:"Admin authentication required"});next()}
app.post("/api/admin/login",(req,res)=>{
 if(String(req.body?.password||"")!==ADMIN_PASSWORD)return res.status(401).json({error:"Invalid admin password"});
 res.cookie("admin_session",sign("admin"),{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000});
 res.json({ok:true});
});
app.get("/api/admin/summary",adminOnly,(req,res)=>{
 const voters=db.prepare("SELECT COUNT(*) n FROM voters").get().n;
 const voted=db.prepare("SELECT COUNT(*) n FROM voters WHERE has_voted=1").get().n;
 const candidates=db.prepare("SELECT COUNT(*) n FROM candidates").get().n;
 const positions=db.prepare("SELECT COUNT(*) n FROM positions").get().n;
 res.json({school_name:getSetting("school_name"),election_open:getSetting("election_open")==="1",results_published:getSetting("results_published")==="1",voters,voted,candidates,positions,turnout:voters?Math.round(voted*1000/voters)/10:0});
});
app.post("/api/admin/settings",adminOnly,(req,res)=>{
 if("election_open" in req.body)setSetting("election_open",req.body.election_open?"1":"0");
 if("results_published" in req.body)setSetting("results_published",req.body.results_published?"1":"0");
 if("school_name" in req.body && String(req.body.school_name).trim())setSetting("school_name",String(req.body.school_name).trim());
 audit("admin","Settings updated");res.json({ok:true});
});
app.post("/api/admin/position",adminOnly,(req,res)=>{
 const name=String(req.body?.name||"").trim(); const max=Number(req.body?.max_choices||1);
 if(!name||max<1||max>10)return res.status(400).json({error:"Invalid position"});
 const r=db.prepare("INSERT INTO positions(name,max_choices,sort_order) VALUES(?,?,?)").run(name,max,Date.now());
 audit("admin","Position created: "+name);res.json({id:r.lastInsertRowid});
});
app.post("/api/admin/candidate",adminOnly,(req,res)=>{
 const name=String(req.body?.name||"").trim(), position=Number(req.body?.position_id);
 if(!name||!db.prepare("SELECT id FROM positions WHERE id=?").get(position))return res.status(400).json({error:"Invalid candidate"});
 const r=db.prepare("INSERT INTO candidates(position_id,name,bio,photo_url) VALUES(?,?,?,?)").run(position,name,String(req.body.bio||""),String(req.body.photo_url||""));
 audit("admin","Candidate created: "+name);res.json({id:r.lastInsertRowid});
});
app.post("/api/admin/voter",adminOnly,(req,res)=>{
 const student_id=String(req.body?.student_id||"").trim(),name=String(req.body?.name||"").trim(),password=String(req.body?.password||"");
 if(!student_id||!name||password.length<6)return res.status(400).json({error:"Student ID, name and a 6+ character password are required"});
 try{db.prepare("INSERT INTO voters(student_id,name,password_hash) VALUES(?,?,?)").run(student_id,name,hash(password));audit("admin","Voter created: "+student_id);res.json({ok:true})}
 catch{res.status(409).json({error:"Student ID already exists"})}
});
app.get("/api/admin/data",adminOnly,(req,res)=>{
 res.json({
  positions:db.prepare("SELECT * FROM positions ORDER BY sort_order,id").all(),
  candidates:db.prepare("SELECT * FROM candidates ORDER BY position_id,id").all(),
  logs:db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50").all()
 });
});

app.listen(PORT,()=>console.log(`${SCHOOL} running on http://localhost:${PORT}`));
