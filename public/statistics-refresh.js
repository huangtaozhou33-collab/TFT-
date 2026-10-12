// Check local publication fingerprints; never contact statistical providers here.
export function watchStatistics({api,onChange,intervalMs=300000}) {
  let version=null,pending=false;
  async function check(){
    if(pending||document.visibilityState==='hidden')return;
    pending=true;
    try{const value=await api('/api/statistics-version');
      if(value.version&&version&&value.version!==version)onChange();
      if(value.version)version=value.version;
    }catch{/* Keep the rendered data during a local service interruption. */}
    finally{pending=false;}
  }
  document.addEventListener('visibilitychange',check);
  window.addEventListener('hashchange',check);
  setInterval(check,intervalMs);check();
}
