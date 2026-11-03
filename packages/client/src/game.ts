import Phaser from "phaser";
import type { NpcDescriptor, NpcId } from "@glc/shared";

type Visual = { u: number; v: number; suit: number; trim: number; skin: number; hair: number; hairStyle: "short"|"side"|"curly"|"flat"; stature?: number };

const visuals: Record<string, Visual> = {
  john:    { u: 3.55, v: 3.7, suit: 0x13794b, trim: 0x8effb9, skin: 0x855a43, hair: 0x141d1c, hairStyle: "short" },
  hal:     { u: 5.85, v: 1.6, suit: 0x188c57, trim: 0xb1ffd6, skin: 0xc38b69, hair: 0x3a241a, hairStyle: "side" },
  kyle:    { u: 2.2, v: 5.25, suit: 0x247659, trim: 0x9ef8d2, skin: 0xab785a, hair: 0x171d22, hairStyle: "curly" },
  guy:     { u: 6.1, v: 6.0, suit: 0x41844a, trim: 0xf2ee9c, skin: 0xcb936b, hair: 0x9c3b1e, hairStyle: "flat" },
  sinestro:{ u: 1.1, v: 1.45, suit: 0x736421, trim: 0xffdf76, skin: 0xad667a, hair: 0x16171d, hairStyle: "short" },
  kilowog: { u: 6.2, v: 3.8, suit: 0x447b4e, trim: 0x90efb5, skin: 0xa98171, hair: 0x493a32, hairStyle: "flat", stature: 1.15 }
};

const iso = (u: number, v: number) => ({ x: 495 + (u-v)*48, y: 242 + (u+v)*25 });

function diamond(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, color: number, outline = 0x365f55) {
  g.fillStyle(color);
  g.lineStyle(1, outline, 0.75);
  g.beginPath();
  g.moveTo(x,y-h); g.lineTo(x+w,y); g.lineTo(x,y+h); g.lineTo(x-w,y);
  g.closePath(); g.fillPath(); g.strokePath();
}

function paintRoom(scene: Phaser.Scene) {
  const backdrop=scene.add.graphics();
  backdrop.fillGradientStyle(0x061518,0x061518,0x173b33,0x092526);
  backdrop.fillRect(-200,-200,1450,1000);

  const bloom=scene.add.graphics();
  bloom.fillStyle(0x41bb85,0.05); bloom.fillEllipse(500,392,880,450);

  const base=scene.add.graphics();
  // Sidewalls with simple architecture behind the isometric tiled floor.
  const corner=iso(-0.52,-0.52);
  const north=iso(7.52,-0.52);
  const west=iso(-0.52,7.52);
  base.fillStyle(0x143b36);base.fillPoints([
    new Phaser.Geom.Point(corner.x,corner.y),
    new Phaser.Geom.Point(north.x,north.y),
    new Phaser.Geom.Point(north.x,north.y-72),
    new Phaser.Geom.Point(corner.x,corner.y-72)
  ],true);
  base.fillStyle(0x0c292b);base.fillPoints([
    new Phaser.Geom.Point(corner.x,corner.y),
    new Phaser.Geom.Point(west.x,west.y),
    new Phaser.Geom.Point(west.x,west.y-72),
    new Phaser.Geom.Point(corner.x,corner.y-72)
  ],true);
  base.lineStyle(3,0x3a9972,0.7);
  base.lineBetween(north.x,north.y-70,corner.x,corner.y-70);
  base.lineBetween(west.x,west.y-70,corner.x,corner.y-70);
  // Floor consists of original vector geometry, not copyrighted art.
  for(let u=0;u<8;u++) for(let v=0;v<8;v++){
    const p=iso(u,v);
    diamond(base,p.x,p.y,48,25,(u+v)%2===0?0x214e43:0x194339);
    if(u===0||v===0||u===7||v===7){
      base.fillStyle(0x80f2bb,0.20);base.fillCircle(p.x,p.y,1.4);
    }
  }
  const outline=scene.add.graphics();
  outline.lineStyle(3,0x76dfaa,0.8);
  const points=[iso(-.5,-.5),iso(7.5,-.5),iso(7.5,7.5),iso(-.5,7.5)];
  outline.beginPath();outline.moveTo(points[0].x,points[0].y);
  for(let i=1;i<points.length;i++)outline.lineTo(points[i].x,points[i].y);
  outline.closePath();outline.strokePath();

  // Center floor insignia: an original concentric energy ring.
  const center=iso(3.5,3.5);
  const insignia=scene.add.graphics();
  insignia.lineStyle(2,0x55d49d,0.18);insignia.strokeEllipse(center.x,center.y,160,83);
  insignia.lineStyle(2,0x7afaaf,0.14);insignia.strokeEllipse(center.x,center.y,112,54);

  const topText=scene.add.text(495,46,"OA / CENTRAL COMMAND",{
    fontFamily:"Arial",fontSize:"16px",fontStyle:"bold",color:"#96ffbf"
  }).setOrigin(.5);
  scene.add.text(495,68,"SECTOR 2814   •   CORPS PERSONNEL SIMULATION",{
    fontFamily:"Arial",fontSize:"10px",color:"#719e8d"
  }).setOrigin(.5);
  topText.setShadow(0,0,"#36ce85",12);
}

function workstation(scene:Phaser.Scene, u:number,v:number,accent:number,label:string){
  const p=iso(u,v);
  const g=scene.add.graphics();
  diamond(g,p.x,p.y+9,48,21,0x103c35,accent);
  g.fillStyle(0x0b262a);g.fillRoundedRect(p.x-31,p.y-38,62,37,5);
  g.lineStyle(2,accent,.7);g.strokeRoundedRect(p.x-31,p.y-38,62,37,5);
  g.lineStyle(1,accent,.3);
  for(let i=0;i<3;i++)g.lineBetween(p.x-23,p.y-29+i*9,p.x+16,p.y-29+i*9);
  const name=scene.add.text(p.x,p.y-51,label.toUpperCase(),{
    fontFamily:"Arial",fontSize:"9px",fontStyle:"bold",color:"#b1e8ce"
  }).setOrigin(.5);
  name.setAlpha(.7);
  scene.tweens.add({targets:g,alpha:{from:.75,to:1},duration:1500,yoyo:true,repeat:-1});
}

function createCharacter(scene:Phaser.Scene,npc:NpcDescriptor,onSelect:(id:NpcId)=>void,index:number){
  const visual=visuals[npc.id] ?? {
    u:2+index%4,v:2+Math.floor(index/4)*2,suit:0x396d6a,trim:0xa5dbc6,
    skin:0xb38c7b,hair:0x232426,hairStyle:"short" as const
  };
  const start=iso(visual.u,visual.v);
  const root=scene.add.container(start.x,start.y);
  const figure=scene.add.container(0,0);
  const pen=scene.add.graphics();

  // Distinct silhouettes and palettes; detailed sprite sheets replace these in art phase.
  const scale=visual.stature??1;
  pen.fillStyle(0x03140d,0.5);pen.fillEllipse(0,6,41*scale,12);
  pen.fillStyle(0x0b2723);
  pen.fillRoundedRect(-14*scale,-27*scale,12*scale,31*scale,3);
  pen.fillRoundedRect(2*scale,-27*scale,12*scale,31*scale,3);
  pen.fillStyle(visual.suit);
  pen.fillRoundedRect(-19*scale,-65*scale,38*scale,39*scale,9);
  pen.fillStyle(0x102f26);pen.fillRoundedRect(-13*scale,-63*scale,26*scale,21*scale,5);
  pen.lineStyle(2,visual.trim,0.9);
  pen.strokeRoundedRect(-19*scale,-65*scale,38*scale,39*scale,9);
  pen.fillStyle(visual.suit);
  pen.fillRoundedRect(-24*scale,-57*scale,9*scale,28*scale,4);
  pen.fillRoundedRect(15*scale,-57*scale,9*scale,28*scale,4);
  pen.fillStyle(visual.trim);pen.fillCircle(0,-45*scale,4*scale);
  pen.fillStyle(visual.skin);pen.fillEllipse(0,-80*scale,25*scale,29*scale);
  pen.fillStyle(visual.hair);
  if(visual.hairStyle==="curly"){
    for(let i=0;i<5;i++)pen.fillCircle((-11+i*5)*scale,-92*scale,6*scale);
  } else if(visual.hairStyle==="side") {
    pen.fillEllipse(-3*scale,-94*scale,28*scale,12*scale);
    pen.fillRoundedRect(-14*scale,-93*scale,8*scale,16*scale,3);
  } else if(visual.hairStyle==="flat"){
    pen.fillRoundedRect(-13*scale,-95*scale,26*scale,9*scale,3);
  } else {
    pen.fillEllipse(0,-94*scale,27*scale,12*scale);
  }
  figure.add(pen);
  root.add(figure);

  const halo=scene.add.graphics();
  halo.lineStyle(2, visual.trim, npc.status==="ready"?.82:.25);
  halo.strokeEllipse(0,0,58,23);
  root.addAt(halo,0);

  const caption=scene.add.text(0,-123*scale,npc.displayName.toUpperCase(),{
    fontFamily:"Arial",fontSize:"10px",fontStyle:"bold",color:"#e5ffee",
    backgroundColor:"#082725e6",padding:{x:6,y:4}
  }).setOrigin(.5);
  root.add(caption);
  const state=scene.add.text(0,-109*scale,
    npc.status==="ready"?"● ONLINE":"◌ NOT CONNECTED",{
      fontFamily:"Arial",fontSize:"9px",
      color:npc.status==="ready"?"#8bffc1":"#b3bda8"
    }).setOrigin(.5);
  root.add(state);

  // A child hit area moves with its actor as it wanders.
  const hit=scene.add.zone(0,-50*scale,82,122*scale)
    .setInteractive({useHandCursor:true});
  root.add(hit);
  hit.on("pointerover",()=>caption.setColor("#84f6b9"));
  hit.on("pointerout",()=>caption.setColor("#e5ffee"));
  hit.on("pointerdown",()=>onSelect(npc.id));

  scene.tweens.add({
    targets:figure,y:-3,duration:1300+(index*137)%600,
    repeat:-1,yoyo:true,ease:"Sine.easeInOut"
  });
  // Wandering is visual-only, offline and never calls an AI provider.
  const move=()=>{
    if(!scene.scene.isActive())return;
    const dx=(index%2===0?1:-1)*(10+index%3*4);
    scene.tweens.add({
      targets:root,x:start.x+dx,y:start.y+(index%3-1)*4,
      duration:1700+index*130,ease:"Sine.easeInOut",
      yoyo:true,hold:1200+index*320,
      onComplete:()=>{
        if(scene.scene.isActive()) scene.time.delayedCall(1500+index*250,move);
      }
    });
  };
  scene.time.delayedCall(1400+index*480,move);
}

export function mountHeadquarters(
  element: HTMLElement,
  npcs: NpcDescriptor[],
  onSelect: (id:NpcId)=>void
) {
  let dragStartedOnNpc=false;
  let releasePointer: (()=>void)|undefined;
  class Headquarters extends Phaser.Scene {
    constructor(){super("headquarters");}
    create(){
      paintRoom(this);
      workstation(this,1.2,1.1,0xdac25f,"Comms A");
      workstation(this,6.1,1.5,0x58eeb2,"Research");
      workstation(this,1.8,5.7,0x52e5c9,"Design");
      workstation(this,6.1,5.6,0x88d58c,"Operations");

      npcs.forEach((npc,index)=>createCharacter(this,npc,id=>{
        dragStartedOnNpc=true;
        onSelect(id);
      },index));

      this.cameras.main.setBounds(-180,-120,1350,980);
      this.cameras.main.setZoom(1);
      this.input.keyboard?.disableGlobalCapture();
      const cursor=this.input.keyboard?.createCursorKeys();
      const keys=this.input.keyboard?.addKeys("W,A,S,D") as Record<string,Phaser.Input.Keyboard.Key>|undefined;
      this.input.keyboard?.disableGlobalCapture();
      this.events.on("update",(_time:number,delta:number)=>{
        const focused=document.activeElement;
        if(focused instanceof HTMLElement &&
          (focused.matches("input, textarea, select")||focused.isContentEditable))return;
        const cam=this.cameras.main;const speed=delta*.45/cam.zoom;
        if(cursor?.left.isDown||keys?.A?.isDown)cam.scrollX-=speed;
        if(cursor?.right.isDown||keys?.D?.isDown)cam.scrollX+=speed;
        if(cursor?.up.isDown||keys?.W?.isDown)cam.scrollY-=speed;
        if(cursor?.down.isDown||keys?.S?.isDown)cam.scrollY+=speed;
      });
      this.input.on("wheel",(_p:Phaser.Input.Pointer,_objs:unknown,_dx:number,dy:number)=>{
        const cam=this.cameras.main;
        cam.setZoom(Phaser.Math.Clamp(cam.zoom+(dy>0?-.07:.07),.65,1.5));
      });
      this.input.on("pointermove",(p:Phaser.Input.Pointer)=>{
        if(p.isDown&&!dragStartedOnNpc&&p.downElement===this.game.canvas){
          this.cameras.main.scrollX-=(p.x-p.prevPosition.x)/this.cameras.main.zoom;
          this.cameras.main.scrollY-=(p.y-p.prevPosition.y)/this.cameras.main.zoom;
        }
      });
      releasePointer=()=>{dragStartedOnNpc=false;};
      window.addEventListener("pointerup",releasePointer);
    }
  }
  const game=new Phaser.Game({
    type:Phaser.AUTO,parent:element,width:990,height:640,
    backgroundColor:"#06191a",
    scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH},
    render:{pixelArt:false,antialias:true},
    scene:[Headquarters],audio:{noAudio:true}
  });
  return ()=>{
    if(releasePointer)window.removeEventListener("pointerup",releasePointer);
    game.destroy(true);
  };
}
