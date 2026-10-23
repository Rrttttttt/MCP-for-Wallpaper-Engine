import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import sharp from 'sharp';
import {Fault,hash,json,noLinks,readTree,writeTree,manifest} from './files.js';
import {readAssetSource} from './assets.js';
import {imageMetadata} from './images.js';
import {Projects,checkProperties,validate} from './projects.js';

const maxTextureBytes=33*1024*1024;
function active(signal?:AbortSignal) {if(signal?.aborted) throw new Fault('SCENE_CANCELLED','Scene creation was cancelled before saving a project.');}

// Deterministic RGBA radial light, generated from geometry; no source-image editing or segmentation.
async function lightPng() {
  const size=64,data=Buffer.alloc(size*size*4);
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const i=(y*size+x)*4,r=Math.hypot((x+.5-size/2)/(size/2),(y+.5-size/2)/(size/2));
    data[i]=255;data[i+1]=230;data[i+2]=170;data[i+3]=Math.round(220*Math.max(0,1-r)**2);
  }
  return sharp(data,{raw:{width:size,height:size,channels:4}}).png().toBuffer();
}

export async function imageSceneFiles(data:Buffer,properties:Record<string,unknown>={}) {
  if(data.length>20*1024*1024) throw new Fault('IMAGE_LIMIT','Image source exceeds 20 MiB.');
  const image=await imageMetadata(data),width=image.displayWidth,height=image.displayHeight;
  if(width*height>8388608) throw new Fault('SCENE_IMAGE_LIMIT','Uncompressed Scene textures are limited to 8388608 pixels.');
  const png=await sharp(data,{limitInputPixels:8388608}).autoOrient().toColourspace('srgb').timeout({seconds:10}).png().toBuffer();
  if(data.length+png.length+width*height*4+256*1024>64*1024*1024) throw new Fault('SCENE_IMAGE_LIMIT','Source, decoded PNG and uncompressed texture would exceed the project budget.');
  const files=await readTree(fileURLToPath(new URL('../templates/scene-orbit/',import.meta.url)));
  files.delete('materials/mcp_orb.tex');
  const p=manifest(files),scene=JSON.parse(files.get('scene.json')!.toString());
  p.description='Original image background and an independent procedural light; no foreground segmentation or upscaling.';
  p.general.properties={
    speed:{type:'slider',text:'Light speed',min:0,max:2,fraction:true,value:.08,order:0},
    amplitude:{type:'slider',text:'Light travel',min:0,max:Math.floor(width*.2),fraction:true,value:Math.round(width*.03),order:1},
    lightSize:{type:'slider',text:'Light size',min:4,max:Math.max(4,Math.floor(Math.min(width,height)*.15)),fraction:true,value:Math.max(4,Math.round(Math.min(width,height)*.035)),order:2},
    lightVisible:{type:'bool',text:'Show light',value:true,order:3}
  };
  checkProperties(p.general.properties,properties);
  for(const [key,value] of Object.entries(properties)) p.general.properties[key].value=value;
  scene.general.orthogonalprojection={width,height};scene.general.clearcolor='0 0 0';
  const light=scene.objects[0];light.id=2;light.name='Independent light';light.origin.value=`${width*.18} ${height*.8} 0`;
  light.size='64 64';
  const scale=p.general.properties.lightSize.value/64;
  light.scale={value:`${scale} ${scale} 1`,script:"'use strict';\nexport function update(value) { value.x = engine.userProperties.lightSize / 64; value.y = engine.userProperties.lightSize / 64; value.z = 1; return value; }\n"};
  light.visible={value:p.general.properties.lightVisible.value,script:"'use strict';\nexport function update(value) { return engine.userProperties.lightVisible; }\n"};
  scene.objects=[{id:1,name:'Original image background',image:'models/mcp_background.json',origin:`${width/2} ${height/2} 0`,size:`${width} ${height}`},light];
  files.set('project.json',Buffer.from(json(p)));files.set('scene.json',Buffer.from(json(scene)));
  files.set(`sources/original.${image.format==='jpeg'?'jpg':image.format}`,data);
  files.set('materials/mcp_background.png',png);files.set('materials/mcp_orb.png',await lightPng());
  files.set('materials/mcp_background.tex-json',files.get('materials/mcp_orb.tex-json')!);
  files.set('models/mcp_background.json',Buffer.from(json({autosize:true,material:'materials/mcp_background.json'})));
  const material=JSON.parse(files.get('materials/mcp_orb.json')!.toString());material.passes[0].textures=['mcp_background'];
  files.set('materials/mcp_background.json',Buffer.from(json(material)));
  return {files,image};
}

async function compile(compiler:string,scratch:string,installDir:string,stem:string,signal?:AbortSignal) {
  active(signal);
  const output=`materials/${stem}.tex`;
  const stdout=await new Promise<string>((resolve,reject)=>{
    execFile(compiler,['-tex','-i',path.join(scratch,'materials',stem+'.png').replaceAll('\\','/'),'-o',path.join(scratch,output).replaceAll('\\','/')],
      {cwd:installDir,windowsHide:true,shell:false,timeout:30000,maxBuffer:64*1024,signal},
      (error,stdout)=>error?reject(new Fault(signal?.aborted?'SCENE_CANCELLED':'TEXTURE_COMPILE_FAILED','Official texture compiler failed, was cancelled or exceeded its 30 second / 64 KiB output budget.')):resolve(stdout));
  });
  const data=await readAssetSource({workspace:scratch,projectRoots:[],assetRoots:[scratch],timeoutMs:1000},0,output,maxTextureBytes,'TEXTURE_LIMIT');
  if(data.length<32||data.toString('ascii',0,9)!=='TEXV0005\x00') throw new Fault('INVALID_TEXTURE','Compiler did not produce a bounded TEXV0005 texture.');
  return {data,output,stdout:stdout.slice(0,4096)};
}

export async function createImageScene(projects:Projects,args:{name:string;title:string;sourceRoot:number;sourcePath:string;expectedSourceHash:string;properties:Record<string,unknown>},signal?:AbortSignal) {
  active(signal);
  if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.name)) throw new Fault('INVALID_NAME','Name must use lowercase ASCII letters, digits and hyphens.');
  const destination=await projects.resolve('managed/'+args.name,true);
  try {await fs.lstat(destination);throw new Fault('PROJECT_EXISTS','New Scene destination already exists.');} catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;}
  if(process.platform!=='win32'||!projects.config.installDir) throw new Fault('TEXTURE_COMPILER_UNAVAILABLE','Requires Windows and the official engine installDir. No compiler is downloaded or redistributed.');
  const compiler=path.join(projects.config.installDir,'bin','resourcecompiler64.exe');await noLinks(compiler);
  try {if(!(await fs.stat(compiler)).isFile()) throw new Error();} catch {throw new Fault('TEXTURE_COMPILER_UNAVAILABLE','Official resourcecompiler64.exe was not found.');}
  const data=await readAssetSource(projects.config,args.sourceRoot,args.sourcePath,20*1024*1024,'IMAGE_LIMIT');
  if(hash(data)!==args.expectedSourceHash) throw new Fault('SOURCE_CHANGED','Image hash differs from inspect; inspect again.');
  const {files,image}=await imageSceneFiles(data,args.properties);active(signal);
  const scratchRoot=path.join(projects.config.workspace,'scene-builds');await noLinks(scratchRoot);await fs.mkdir(scratchRoot,{recursive:true});
  const scratch=await fs.mkdtemp(path.join(scratchRoot,'build-'));
  const compilation:{path:string;sha256:string;bytes:number;stdout:string}[]=[];
  try {
    await writeTree(scratch,files);
    for(const stem of ['mcp_background','mcp_orb']) {
      const result=await compile(compiler,scratch,projects.config.installDir,stem,signal);
      files.set(result.output,result.data);compilation.push({path:result.output,sha256:hash(result.data),bytes:result.data.length,stdout:result.stdout});
    }
    const report=validate(files);if(!report.valid) throw new Fault('VALIDATION_FAILED','Compiled Scene candidate failed validation.',report);
    active(signal);
  } finally {
    // Only this mkdtemp child qualifies for cleanup; never remove a project or configured workspace root.
    const relative=path.relative(scratchRoot,scratch);
    if(!relative.startsWith('build-')||relative.includes(path.sep)||path.resolve(scratch)!==path.join(scratchRoot,relative)) throw new Fault('UNSAFE_PATH','Refusing unexpected build cleanup path.');
    await noLinks(scratch);await fs.rm(scratch,{recursive:true,force:true});
  }
  active(signal);
  const saved=await projects.createFiles(args.name,args.title,files,{sourceProjectId:null,templateId:'scene-image-light',imageSourceHash:image.sha256});
  return {...saved,image,originalBytesPreserved:true,compilation:{compiler,format:'rgba8888',mipmaps:false,textures:compilation},
    scope:'Two independent image layers, not character/background segmentation. PNG is oriented and converted to sRGB for compilation; original source bytes remain in sources/. Texture header checks are not full TEX decoding. Inspect native frames and live property response in the official engine.'};
}
