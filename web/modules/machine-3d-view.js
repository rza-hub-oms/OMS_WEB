// Lightweight 3D machine visualization. Scene coordinates are derived from the existing 2D layout.
// Three.js is loaded only when the operator opens 3D view, keeping the standard editor lightweight.
export async function createMachine3DView(container, statusEl) {
  const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121d28);
  scene.fog = new THREE.Fog(0x121d28, 900, 2600);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.replaceChildren(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xc8e3ff, 0x27313a, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(-400, 700, 500); key.castShadow = true; scene.add(key);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({color:0x182630, roughness:.92}));
  floor.rotation.x = -Math.PI/2; floor.position.y = -4; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(2400, 60, 0x3b5262, 0x293b49); grid.position.y = -2.8; scene.add(grid);
  const machineRoot = new THREE.Group(); scene.add(machineRoot);
  const meshes = new Map(); let currentState = {};
  const mat = (color, metalness=.25, roughness=.55) => new THREE.MeshStandardMaterial({color, metalness, roughness});
  const steel=mat(0x8395a3,.72,.35), dark=mat(0x273744,.5,.45), belt=mat(0x202a31,.1,.85), blue=mat(0x2585c7,.35,.4), orange=mat(0xef9a35,.2,.5), green=mat(0x36b77b,.1,.45), red=mat(0xd84c4c,.1,.45), productMat=mat(0xd6a64b,.12,.4);
  function box(parent, size, material, pos) { const m=new THREE.Mesh(new THREE.BoxGeometry(...size),material); m.position.set(...pos); m.castShadow=true; m.receiveShadow=true; parent.add(m); return m; }
  function cylinder(parent, radius, length, material, pos, axis='x') { const m=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,length,20),material); if(axis==='x')m.rotation.z=Math.PI/2; if(axis==='z')m.rotation.x=Math.PI/2; m.position.set(...pos);m.castShadow=true;parent.add(m);return m; }
  function makeObject(tag,obj) {
    const g=new THREE.Group(); g.userData.tag=tag;
    const w=Math.max(18,Number(obj.width)||80), h=Math.max(12,Number(obj.height)||36), d=Math.max(22,h*.8);
    const type=obj.type;
    if(type==='conveyor') {
      box(g,[w,8,d],dark,[0,7,0]); box(g,[w-8,3,d-8],belt,[0,12,0]);
      const count=Math.max(4,Math.min(24,Math.round(w/18)));
      for(let i=0;i<count;i++){const x=-w/2+8+i*(w-16)/(count-1); cylinder(g,Math.max(2,d*.09),d-5,steel,[x,5,0],'z');}
      box(g,[w,5,3],steel,[0,15,-d/2+2]); box(g,[w,5,3],steel,[0,15,d/2-2]);
      const products=[]; for(let i=0;i<Math.min(8,(obj.box_positions||[]).length);i++) products.push(box(g,[Math.max(10,Number(obj.box_width)||22),Math.max(8,Number(obj.box_height)||14),Math.max(10,d*.55)],productMat,[0,22,0])); g.userData.products=products;
    } else if(type==='motor') {
      cylinder(g,Math.max(10,h*.28),Math.max(22,w*.65),blue,[0,Math.max(14,h*.3),0]); cylinder(g,Math.max(4,h*.12),Math.max(10,w*.28),steel,[w*.42,Math.max(14,h*.3),0]);
      box(g,[w*.45,5,d*.5],dark,[-w*.1,5,0]);
      for(let i=0;i<5;i++) box(g,[3,h*.45,d*.8],steel,[-w*.22+i*w*.1,Math.max(15,h*.3),0]);
    } else if(type==='cylinder') {
      box(g,[w*.7,Math.max(10,h*.42),Math.max(12,d*.55)],blue,[-w*.12,Math.max(12,h*.25),0]);
      cylinder(g,Math.max(3,h*.1),w*.42,steel,[w*.4,Math.max(12,h*.25),0]); box(g,[8,h*.45,d*.65],orange,[w*.62,Math.max(12,h*.25),0]);
    } else if(type==='index_table') {
      cylinder(g,Math.max(14,w*.38),8,steel,[0,10,0],'y'); cylinder(g,Math.max(10,w*.29),5,blue,[0,16,0],'y');
      for(let i=0;i<4;i++){const a=i*Math.PI/2;box(g,[Math.max(8,w*.12),5,Math.max(8,w*.12)],orange,[Math.cos(a)*w*.24,21,Math.sin(a)*w*.24]);}
    } else if(type==='sensor') {
      box(g,[w,4,h],steel,[0,2,0]); box(g,[Math.min(w,h)*.4,10,Math.min(w,h)*.4],green,[0,9,0]);
      const zone=new THREE.Mesh(new THREE.BoxGeometry(w,30,h),new THREE.MeshBasicMaterial({color:0x4a9fbe,transparent:true,opacity:.25,depthWrite:false}));
      zone.position.set(0,19,0); zone.userData.zone=true; zone.raycast=()=>{}; g.add(zone);
    } else if(type==='tower_light') {
      cylinder(g,Math.max(5,w*.12),Math.max(10,h*.6),steel,[0,Math.max(8,h*.3),0],'y');
      [red,orange,green].forEach((m,i)=>cylinder(g,Math.max(5,w*.14),Math.max(6,h*.16),m,[0,Math.max(12,h*.6)+i*7,0],'y'));
    } else if(type==='push_button'||type==='emergency_push_button'||type==='toggle_switch') {
      box(g,[Math.max(20,w*.65),7,Math.max(20,d*.65)],dark,[0,4,0]); cylinder(g,Math.max(6,w*.18),Math.max(8,h*.4),type==='emergency_push_button'?red:type==='toggle_switch'?steel:green,[0,Math.max(12,h*.35),0],'y');
    } else {
      box(g,[w,Math.max(8,h*.3),d],type==='label'?dark:steel,[0,Math.max(5,h*.15),0]);
    }
    g.userData.dimensions={w,h,d}; return g;
  }
  function update(state) {
    currentState=state||{};
    for(const [tag,g] of meshes) if(!currentState[tag]) {machineRoot.remove(g);meshes.delete(tag);}
    const entries=Object.entries(currentState).filter(([,o])=>o&&o.type);
    for(const [tag,obj] of entries) {
      let g=meshes.get(tag); if(!g||g.userData.type!==obj.type){if(g)machineRoot.remove(g);g=makeObject(tag,obj);g.userData.type=obj.type;meshes.set(tag,g);machineRoot.add(g);}
      const w=Math.max(18,Number(obj.width)||80), h=Math.max(12,Number(obj.height)||36);
      g.position.set((Number(obj.x)||0)+w/2,0,(Number(obj.y)||0)+h/2);
      g.rotation.y=-(Number(obj.rotation)||0)*Math.PI/180;
      if(obj.type==='conveyor') {
        const pos=obj.box_positions||[], products=g.userData.products||(g.userData.products=[]); const travel=Math.max(1,w-(Number(obj.box_width)||22));
        while(products.length<pos.length) products.push(box(g,[Math.max(10,Number(obj.box_width)||22),Math.max(8,Number(obj.box_height)||14),Math.max(10,Math.max(22,h*.8)*.55)],productMat,[0,22,0]));
        products.forEach((p,i)=>{p.visible=i<pos.length;if(pos[i]!=null)p.position.x=-w/2+Math.min(travel,Math.max(0,pos[i]))+(Number(obj.box_width)||22)/2;});
        //g.children.forEach((m,i)=>{if(m.geometry?.type==='CylinderGeometry' && obj.running)m.rotation.x += .025;});
        g.children.forEach(m=>{if(m.geometry?.type==='CylinderGeometry'){m.rotation.y=-(Number(obj.belt_phase)||0)/m.geometry.parameters.radiusTop;}});
      }
      if(obj.type==='cylinder') {const rod=g.children.find(m=>m.geometry?.type==='CylinderGeometry');if(rod)rod.position.x=w*.18+(obj.extended?w*.2:0);}
      g.userData.tag=tag;
    }
    statusEl.textContent=`${entries.length} machine components · ${entries.filter(([,o])=>o.running).length} running · drag to orbit / scroll to zoom`;
    if(entries.length){const maxX=Math.max(...entries.map(([,o])=>(Number(o.x)||0)+(Number(o.width)||80))),maxY=Math.max(...entries.map(([,o])=>(Number(o.y)||0)+(Number(o.height)||36))); const centerX=maxX/2,centerZ=maxY/2; floor.position.set(centerX,-4,centerZ);grid.position.set(centerX,-2.8,centerZ);}
  }
  let target=new THREE.Vector3(300,0,200), radius=650, theta=Math.PI/4, phi=Math.PI/3;
  function placeCamera(){phi=Math.max(.18,Math.min(Math.PI/2-.05,phi));camera.position.set(target.x+radius*Math.sin(phi)*Math.cos(theta),target.y+radius*Math.cos(phi),target.z+radius*Math.sin(phi)*Math.sin(theta));camera.lookAt(target);}
  function resetCamera(){target.set(300,0,200);radius=650;theta=Math.PI/4;phi=Math.PI/3;placeCamera();}
  resetCamera();
  let dragging=false,lastX=0,lastY=0;
  renderer.domElement.addEventListener('pointerdown',e=>{if(e.button!==0)return;dragging=true;lastX=e.clientX;lastY=e.clientY;});
  window.addEventListener('pointermove',e=>{if(!dragging)return;if(!(e.buttons&1)){dragging=false;return;}theta-=(e.clientX-lastX)*.008;phi+=(e.clientY-lastY)*.008;lastX=e.clientX;lastY=e.clientY;placeCamera();});
  window.addEventListener('pointerup',()=>dragging=false);
  window.addEventListener('pointercancel',()=>dragging=false);
  window.addEventListener('blur',()=>dragging=false);
  renderer.domElement.addEventListener('wheel',e=>{e.preventDefault();
    const rect=renderer.domElement.getBoundingClientRect();
    const ndc=new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
    const rc=new THREE.Raycaster(), plane=new THREE.Plane(new THREE.Vector3(0,1,0),0), p0=new THREE.Vector3(), p1=new THREE.Vector3();
    rc.setFromCamera(ndc,camera); const hit0=rc.ray.intersectPlane(plane,p0);
    radius=Math.max(120,Math.min(1800,radius*Math.exp(e.deltaY*.001))); placeCamera(); camera.updateMatrixWorld();
    rc.setFromCamera(ndc,camera); const hit1=rc.ray.intersectPlane(plane,p1);
    if(hit0&&hit1){target.x+=hit0.x-hit1.x;target.z+=hit0.z-hit1.z;placeCamera();}
  },{passive:false});
  function screenToLayout(clientX, clientY){
    const rect=renderer.domElement.getBoundingClientRect();
    const pointer=new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1,-((clientY-rect.top)/rect.height)*2+1);
    const raycaster=new THREE.Raycaster(); raycaster.setFromCamera(pointer,camera);
    const ground=new THREE.Plane(new THREE.Vector3(0,1,0),0); const hit=new THREE.Vector3();
    if(!raycaster.ray.intersectPlane(ground,hit)) return null;
    return {x:Math.round(hit.x),y:Math.round(hit.z)};
  }

  let onPick=null, downX=0, downY=0;
  function pick(clientX,clientY){
    const rect=renderer.domElement.getBoundingClientRect();
    const p=new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1,-((clientY-rect.top)/rect.height)*2+1);
    const rc=new THREE.Raycaster(); rc.setFromCamera(p,camera);
    const hit=rc.intersectObjects(machineRoot.children,true)[0];
    let o=hit&&hit.object; while(o&&!o.userData.tag) o=o.parent;
    return o?o.userData.tag:null;
  }
  renderer.domElement.addEventListener('pointerdown',e=>{downX=e.clientX;downY=e.clientY;});
  renderer.domElement.addEventListener('click',e=>{if(Math.hypot(e.clientX-downX,e.clientY-downY)>4)return;onPick?.(pick(e.clientX,e.clientY),e);});

  function resize(){const w=Math.max(1,container.clientWidth),h=Math.max(1,container.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
  const ro=new ResizeObserver(resize);ro.observe(container);resize();
  let raf=0;function loop(){raf=requestAnimationFrame(loop);renderer.render(scene,camera);}loop();
  return {update,resetCamera,screenToLayout,setPickHandler(f){onPick=f;},destroy(){cancelAnimationFrame(raf);ro.disconnect();renderer.dispose();container.replaceChildren();}};
}
