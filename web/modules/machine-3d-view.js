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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.replaceChildren(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xc8e3ff, 0x27313a, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(-400, 700, 500); key.castShadow = true; scene.add(key);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({color:0x182630, roughness:.92}));
  floor.rotation.x = -Math.PI/2; floor.position.y = -4; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(2400, 60, 0x3b5262, 0x293b49); grid.position.y = -2.8; scene.add(grid);
  const machineRoot = new THREE.Group(); scene.add(machineRoot);
  const meshes = new Map(); let currentState = {}; let selectedTag = null; let animationTime = 0;
  let transformHandlers = null; let transformTag = null; let transformOffset = null; let transformMoved = false;
  const mat = (color, metalness=.25, roughness=.55) => new THREE.MeshStandardMaterial({color, metalness, roughness});
  const steel=mat(0x8395a3,.72,.35), dark=mat(0x273744,.5,.45), blue=mat(0x2585c7,.35,.4), orange=mat(0xef9a35,.2,.5), green=mat(0x36b77b,.1,.45), red=mat(0xd84c4c,.1,.45), yellow=mat(0xe6c828,.1,.45);
  function canvasTex(draw,w,h){const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=4;return t;}
  const cardboardTex=canvasTex((x,w,h)=>{x.fillStyle='#c79a5b';x.fillRect(0,0,w,h);for(let i=0;i<500;i++){x.fillStyle=`rgba(90,60,20,${Math.random()*.1})`;x.fillRect(Math.random()*w,Math.random()*h,3,1);}x.fillStyle='rgba(235,220,180,.9)';x.fillRect(0,h/2-9,w,18);x.strokeStyle='rgba(70,45,15,.6)';x.lineWidth=4;x.strokeRect(0,0,w,h);},128,128);
  const productMat=new THREE.MeshStandardMaterial({map:cardboardTex,roughness:.85,metalness:0});
  const beltTex=canvasTex((x,w,h)=>{x.fillStyle='#1d252b';x.fillRect(0,0,w,h);x.fillStyle='#2a343b';for(let i=0;i<w;i+=16)x.fillRect(i,0,4,h);},64,64);
  const belt=new THREE.MeshStandardMaterial({map:beltTex,roughness:.92,metalness:.05});
  const chrome=mat(0xdfe6ec,.95,.15), alu=mat(0x9fb2c2,.8,.3);
  const dimLampMats=[mat(0x592c2c,.1,.6),mat(0x29365b,.1,.6),mat(0x28513a,.1,.6),mat(0x5a5023,.1,.6)];
  function box(parent, size, material, pos) { const m=new THREE.Mesh(new THREE.BoxGeometry(...size),material); m.position.set(...pos); m.castShadow=true; m.receiveShadow=true; parent.add(m); return m; }
  function cylinder(parent, radius, length, material, pos, axis='x') { const m=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,length,20),material); if(axis==='x')m.rotation.z=Math.PI/2; if(axis==='z')m.rotation.x=Math.PI/2; m.position.set(...pos);m.castShadow=true;parent.add(m);return m; }
  function makeObject(tag,obj) {
    const g=new THREE.Group(); g.userData.tag=tag;
    const w=Math.max(18,Number(obj.width)||80), h=Math.max(12,Number(obj.height)||36), d=Math.max(22,h*.8);
    const type=obj.type;
    if(type==='conveyor') {
      // Slim fabricated side rails and feet read more like industrial equipment than a solid block.
      box(g,[w,7,5],steel,[0,6,-d/2+2.5]); box(g,[w,7,5],steel,[0,6,d/2-2.5]);
      for(const sx of [-1,1]) for(const sz of [-1,1]) {
        box(g,[6,13,6],dark,[sx*w*.39,-.5,sz*d*.31]);
        box(g,[12,2,10],steel,[sx*w*.39,-7.5,sz*d*.31]);
      }
      const bm=belt.clone();bm.map=beltTex.clone();bm.map.needsUpdate=true;bm.map.repeat.set(w/16,1);g.userData.beltMat=bm;box(g,[w-8,3,d-10],bm,[0,12,0]);
      const count=Math.max(2,Math.min(6,Math.round(w/60)));
      box(g,[w,3,4],dark,[0,15,-d/2+2]); box(g,[w,3,4],dark,[0,15,d/2-2]);
      for(const x of [-w*.45,w*.45]) for(const z of [-d/2+2.5,d/2-2.5]) cylinder(g,1.5,1.5,steel,[x,8,z],'z');
      const rollers=[]; g.children.forEach(m=>{if(m.geometry?.type==='CylinderGeometry') rollers.push(m);}); g.userData.rollers=rollers;
      const products=[]; for(let i=0;i<Math.min(8,(obj.box_positions||[]).length);i++) products.push(box(g,[Math.max(10,Number(obj.box_width)||22),Math.max(8,Number(obj.box_height)||14),Math.max(10,d*.55)],productMat,[0,22,0])); g.userData.products=products;
    } else if(type==='motor') {
      const rotor=cylinder(g,Math.max(10,h*.28),Math.max(22,w*.65),blue,[0,Math.max(14,h*.3),0]); rotor.userData.role='motor-rotor'; const shaft=cylinder(g,Math.max(4,h*.12),Math.max(10,w*.28),steel,[w*.42,Math.max(14,h*.3),0]); shaft.userData.role='motor-shaft'; g.userData.rotor=rotor; g.userData.shaft=shaft;
      box(g,[w*.45,5,d*.5],dark,[-w*.1,5,0]);
      for(let i=0;i<5;i++) box(g,[3,h*.45,d*.8],steel,[-w*.22+i*w*.1,Math.max(15,h*.3),0]);
    } else if(type==='cylinder') {
      const cy=Math.max(12,h*.25), br=Math.max(8,h*.2), bl=w*.6, bx=-w*.15;
      cylinder(g,br,bl,alu,[bx,cy,0]);
      cylinder(g,br*1.15,6,dark,[bx-bl/2,cy,0]); cylinder(g,br*1.15,6,dark,[bx+bl/2,cy,0]);
      cylinder(g,br*1.08,4,blue,[bx-bl*.25,cy,0]); cylinder(g,br*1.08,4,blue,[bx+bl*.25,cy,0]);
      box(g,[bl*.8,3,br*1.6],dark,[bx,cy-br-1.5,0]);
      cylinder(g,2.5,5,steel,[bx-bl*.38,cy+br+2,0],'y'); cylinder(g,2.5,5,steel,[bx+bl*.38,cy+br+2,0],'y');
      const rod=cylinder(g,Math.max(3,br*.35),w*.42,chrome,[w*.4,cy,0]); rod.userData.role='cylinder-rod'; g.userData.rod=rod;
      const head=box(g,[8,br*1.2,br*1.2],orange,[w*.62,cy,0]); g.userData.cylinderHead=head;
    } else if(type==='index_table') {
      cylinder(g,Math.max(14,w*.38),8,steel,[0,10,0],'y'); const tableTop=cylinder(g,Math.max(10,w*.29),5,blue,[0,16,0],'y'); g.userData.tableTop=tableTop;
      for(let i=0;i<4;i++){const a=i*Math.PI/2;box(g,[Math.max(8,w*.12),5,Math.max(8,w*.12)],orange,[Math.cos(a)*w*.24,21,Math.sin(a)*w*.24]);}
    } else if(type==='sensor') {
      box(g,[w,4,h],steel,[0,2,0]); const sensorLight=box(g,[Math.min(w,h)*.4,10,Math.min(w,h)*.4],green,[0,9,0]); sensorLight.userData.role='sensor-light'; g.userData.sensorLight=sensorLight;
      const zone=new THREE.Mesh(new THREE.BoxGeometry(w,30,h),new THREE.MeshBasicMaterial({color:0x4a9fbe,transparent:true,opacity:.18,depthWrite:false}));
      zone.position.set(0,19,0); zone.userData.zone=true; zone.raycast=()=>{}; g.add(zone); g.userData.sensorZone=zone;
    } else if(type==='tower_light') {
      cylinder(g,Math.max(5,w*.12),Math.max(10,h*.6),steel,[0,Math.max(8,h*.3),0],'y');
      const lamps=[]; [red,blue,green,yellow].forEach((m,i)=>{const lamp=cylinder(g,Math.max(5,w*.14),Math.max(6,h*.13),m,[0,Math.max(12,h*.54)+i*7,0],'y'); lamps.push(lamp);}); g.userData.lamps=lamps;
    } else if(type==='push_button'||type==='emergency_push_button'||type==='toggle_switch') {
      box(g,[Math.max(20,w*.65),7,Math.max(20,d*.65)],dark,[0,4,0]); const actuator=cylinder(g,Math.max(6,w*.18),Math.max(8,h*.4),type==='emergency_push_button'?red:type==='toggle_switch'?steel:green,[0,Math.max(12,h*.35),0],'y'); actuator.userData.role='control-actuator'; g.userData.actuator=actuator;
    } else {
      box(g,[w,Math.max(8,h*.3),d],type==='label'?dark:steel,[0,Math.max(5,h*.15),0]);
    }
    const faultLamp= new THREE.Mesh(new THREE.SphereGeometry(Math.max(3,Math.min(w,h)*.07),12,8), red); faultLamp.position.set(w*.42,Math.max(12,h*.55),d*.42); faultLamp.visible=false; faultLamp.userData.role='fault-indicator'; g.add(faultLamp); g.userData.faultLamp=faultLamp;
    g.userData.dimensions={w,h,d}; return g;
  }
  function update(state) {
    currentState=state||{};
    for(const [tag,g] of meshes) if(!currentState[tag]) {machineRoot.remove(g);meshes.delete(tag);}
    const entries=Object.entries(currentState).filter(([,o])=>o&&o.type);
    for(const [tag,obj] of entries) {
      const w=Math.max(18,Number(obj.width)||80), h=Math.max(12,Number(obj.height)||36);
      let g=meshes.get(tag);
      const dim=g&&g.userData.dimensions;
      if(!g||g.userData.type!==obj.type||(tag!==transformTag&&dim&&(dim.w!==w||dim.h!==h))){if(g)machineRoot.remove(g);g=makeObject(tag,obj);g.userData.type=obj.type;meshes.set(tag,g);machineRoot.add(g);}
      if(tag!==transformTag) g.position.set((Number(obj.x)||0)+w/2,0,(Number(obj.y)||0)+h/2);
      if(tag!==transformTag) g.rotation.y=-(Number(obj.rotation)||0)*Math.PI/180;
      if(obj.type==='conveyor') {
        if(g.userData.beltMat)g.userData.beltMat.map.offset.x=-(Number(obj.belt_phase)||0)/16;
        const pos=obj.box_positions||[], products=g.userData.products||(g.userData.products=[]); const travel=Math.max(1,w-(Number(obj.box_width)||22));
        while(products.length<pos.length) products.push(box(g,[Math.max(10,Number(obj.box_width)||22),Math.max(8,Number(obj.box_height)||14),Math.max(10,Math.max(22,h*.8)*.55)],productMat,[0,22,0]));
        products.forEach((p,i)=>{p.visible=i<pos.length;if(pos[i]!=null)p.position.x=-w/2+Math.min(travel,Math.max(0,pos[i]))+(Number(obj.box_width)||22)/2;});
        //g.children.forEach((m,i)=>{if(m.geometry?.type==='CylinderGeometry' && obj.running)m.rotation.x += .025;});
        g.children.forEach(m=>{if(m.geometry?.type==='CylinderGeometry'){m.rotation.z=-(Number(obj.belt_phase)||0)/Math.max(1,m.geometry.parameters.radiusTop); if(obj.running_status||obj.running) m.rotation.z += animationTime*.0008;}});
      }
      if(obj.type==='cylinder') {const rod=g.userData.rod,head=g.userData.cylinderHead; if(rod){const progress=Math.max(0,Math.min(1,Number(obj.progress ?? (obj.extended?1:0)))); rod.position.x=w*.18+progress*w*.2; if(head)head.position.x=rod.position.x+w*.21+4;}}
      const active=!!(obj.running_status ?? obj.running) && !obj.fault && !obj.emergency_stop;
      if(g.userData.rotor){g.userData.rotor.rotation.x=active?animationTime*.002:0; if(g.userData.shaft)g.userData.shaft.rotation.x=active?animationTime*.002:0;}
      if(g.userData.sensorLight){const detected=!!obj.detected;g.userData.sensorLight.material=detected?green:steel;g.userData.sensorLight.scale.setScalar(detected?1.18:1);if(g.userData.sensorZone)g.userData.sensorZone.material.opacity=detected?.38:.12;}
      if(g.userData.actuator){const pressed=!!(obj.pressed ?? obj.on);g.userData.actuator.position.y=Math.max(8,h*.35)-(pressed?3:0);if(obj.type==='toggle_switch')g.userData.actuator.rotation.z=pressed?-.45:.45;}
      if(g.userData.lamps){const lampKeys=['red','blue','green','yellow'];g.userData.lamps.forEach((lamp,i)=>{const on=!!obj[lampKeys[i]];lamp.material=on?[red,blue,green,yellow][i]:dimLampMats[i];});}
      if(g.userData.tableTop && obj.moving)g.userData.tableTop.rotation.y=animationTime*.0015;
      if(g.userData.faultLamp)g.userData.faultLamp.visible=!!(obj.fault||obj.emergency_stop);
      g.userData.isSelected=tag===selectedTag; g.scale.setScalar(tag===selectedTag?1.035:1);
      g.userData.tag=tag;
    }
    statusEl.textContent=`${entries.length} machine components · ${entries.filter(([,o])=>o.running).length} running · drag components to move in Design mode · drag empty space to orbit · scroll to zoom`;
    if(entries.length){const maxX=Math.max(...entries.map(([,o])=>(Number(o.x)||0)+(Number(o.width)||80))),maxY=Math.max(...entries.map(([,o])=>(Number(o.y)||0)+(Number(o.height)||36))); const centerX=maxX/2,centerZ=maxY/2; floor.position.set(centerX,-4,centerZ);grid.position.set(centerX,-2.8,centerZ);}
  }
  let target=new THREE.Vector3(300,0,200), radius=650, theta=Math.PI/4, phi=Math.PI/3;
  function placeCamera(){phi=Math.max(.18,Math.min(Math.PI/2-.05,phi));camera.position.set(target.x+radius*Math.sin(phi)*Math.cos(theta),target.y+radius*Math.cos(phi),target.z+radius*Math.sin(phi)*Math.sin(theta));camera.lookAt(target);}
  function resetCamera(){target.set(300,0,200);radius=650;theta=Math.PI/4;phi=Math.PI/3;placeCamera();}
  resetCamera();
  let dragging=false,lastX=0,lastY=0;
  renderer.domElement.addEventListener('pointerdown',e=>{if(e.button!==0)return;
    const tag=pick(e.clientX,e.clientY);
    if(tag && transformHandlers?.canStart?.(tag,e)) {
      const g=meshes.get(tag), p=groundPoint(e.clientX,e.clientY);
      if(g&&p){transformTag=tag;transformOffset={x:g.position.x-p.x,z:g.position.z-p.z};transformMoved=false;dragging=false;renderer.domElement.style.cursor='grabbing';e.preventDefault();return;}
    }
    dragging=true;lastX=e.clientX;lastY=e.clientY;});
  window.addEventListener('pointermove',e=>{
    if(transformTag){if(!(e.buttons&1)){finishTransform();return;}const p=groundPoint(e.clientX,e.clientY),g=meshes.get(transformTag);if(!p||!g)return;
      const x=Math.round((p.x+transformOffset.x-g.userData.dimensions.w/2)/10)*10;
      const y=Math.round((p.z+transformOffset.z-g.userData.dimensions.h/2)/10)*10;
      g.position.x=x+g.userData.dimensions.w/2;g.position.z=y+g.userData.dimensions.h/2;transformMoved=true;transformHandlers?.move?.(transformTag,x,y);return;
    }
    if(!dragging)return;if(!(e.buttons&1)){dragging=false;return;}theta-=(e.clientX-lastX)*.008;phi+=(e.clientY-lastY)*.008;lastX=e.clientX;lastY=e.clientY;placeCamera();});
  window.addEventListener('pointerup',()=>{if(transformTag){finishTransform();return;}dragging=false;});
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
  function groundPoint(clientX,clientY){
    const rect=renderer.domElement.getBoundingClientRect();
    const pointer=new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1,-((clientY-rect.top)/rect.height)*2+1);
    const raycaster=new THREE.Raycaster();raycaster.setFromCamera(pointer,camera);
    const hit=new THREE.Vector3();return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),hit)?hit:null;
  }
  function finishTransform(){
    if(!transformTag)return;const tag=transformTag,g=meshes.get(tag);if(g&&transformMoved)transformHandlers?.end?.(tag,Math.round((g.position.x-g.userData.dimensions.w/2)/10)*10,Math.round((g.position.z-g.userData.dimensions.h/2)/10)*10);
    transformTag=null;transformOffset=null;transformMoved=false;renderer.domElement.style.cursor='';
  }

  let onPick=null, onInteract=null, interactionTag=null, downX=0, downY=0;
  function pick(clientX,clientY){
    const rect=renderer.domElement.getBoundingClientRect();
    const p=new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1,-((clientY-rect.top)/rect.height)*2+1);
    const rc=new THREE.Raycaster(); rc.setFromCamera(p,camera);
    const hit=rc.intersectObjects(machineRoot.children,true)[0];
    let o=hit&&hit.object; while(o&&!o.userData.tag) o=o.parent;
    return o?o.userData.tag:null;
  }
  renderer.domElement.addEventListener('pointerdown',e=>{downX=e.clientX;downY=e.clientY;interactionTag=pick(e.clientX,e.clientY);if(e.button===0&&interactionTag)onInteract?.(interactionTag,'down',e);});
  window.addEventListener('pointerup',e=>{if(interactionTag)onInteract?.(interactionTag,'up',e);interactionTag=null;});
  renderer.domElement.addEventListener('pointercancel',()=>{if(interactionTag)onInteract?.(interactionTag,'up',{});interactionTag=null;});
  renderer.domElement.addEventListener('click',e=>{if(Math.hypot(e.clientX-downX,e.clientY-downY)>4)return;onPick?.(pick(e.clientX,e.clientY),e);});

  function resize(){const w=Math.max(1,container.clientWidth),h=Math.max(1,container.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
  const ro=new ResizeObserver(resize);ro.observe(container);resize();
  let raf=0;function loop(t=0){raf=requestAnimationFrame(loop);animationTime=t;renderer.render(scene,camera);}loop();
  return {update,resetCamera,screenToLayout,setSelectedTag(tag){selectedTag=tag||null;},setPickHandler(f){onPick=f;},setInteractionHandler(f){onInteract=f;},setTransformHandler(h){transformHandlers=h;},rotateSelected(degrees=90){const g=meshes.get(selectedTag);if(!g)return false;g.rotation.y-=degrees*Math.PI/180;return true;},destroy(){cancelAnimationFrame(raf);ro.disconnect();renderer.dispose();container.replaceChildren();}};
}
