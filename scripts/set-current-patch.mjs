import { getPool,closeDatabase } from '../server/storage/repository.mjs';
const patch=process.argv[2];
try {
  if(!/^\d{1,3}\.\d{1,3}[a-z]?$/.test(patch??''))throw new Error('用法：npm run db:set-patch -- 18.4');
  const db=await getPool(),connection=await db.getConnection();
  try {await connection.beginTransaction();const [rows]=await connection.query('SELECT * FROM runtime_state WHERE id=1 FOR UPDATE');if(!rows.length)throw new Error('请先导入初始数据');await connection.execute('UPDATE runtime_state SET current_patch=? WHERE id=1',[patch]);await connection.execute('INSERT INTO change_log(release_id,kind,detail) VALUES(?,\'current_patch_changed\',?)',[rows[0].active_release,JSON.stringify({from:rows[0].current_patch,to:patch})]);await connection.commit();console.log(JSON.stringify({currentPatch:patch,note:'旧补丁统计和知识已隔离；新资料须另行核验导入。'}));}catch(e){await connection.rollback();throw e;}finally{connection.release();}
}catch(e){console.error(e.message);process.exitCode=1;}finally{await closeDatabase();}
