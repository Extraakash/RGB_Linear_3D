
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LogEntry } from '../types';

declare const UPNG: any;

type LogCallback = (message: string, type?: LogEntry['type']) => void;

const formatBytes = (bytes: number, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const correctGamma = (c: number): number => {
    // linear to sRGB conversion
    return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};

async function processTexture(
    texture: THREE.Texture,
    isDiffuse: boolean,
    log: LogCallback,
    quality: number
): Promise<ArrayBuffer> {
    const image = texture.image as HTMLImageElement;
    const { width, height } = image;
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not get 2D context.');
    
    context.drawImage(image, 0, 0, width, height);

    const imageData = context.getImageData(0, 0, width, height);
    if (isDiffuse) {
        const data = imageData.data;
        const gammaLookup = new Uint8Array(256);
        for(let i=0; i<256; i++) gammaLookup[i] = Math.floor(correctGamma(i/255)*255);

        for (let i = 0; i < data.length; i += 4) {
            data[i] = gammaLookup[data[i]];
            data[i + 1] = gammaLookup[data[i + 1]];
            data[i + 2] = gammaLookup[data[i + 2]];
        }
    }
    context.putImageData(imageData, 0, 0);
    
    const cnum = quality === 100 ? 0 : Math.round(2 + (254 * quality) / 100);
    log(`   > Compressing texture as PNG with quality ${quality === 100 ? 'lossless' : quality} (cnum: ${cnum})`);

    const pngBuffer = UPNG.encode([imageData.data.buffer], width, height, cnum);
    return pngBuffer;
}


export const processGltf = async (file: File, log: LogCallback, quality: number): Promise<Blob> => {
    try {
        log(`Starting GLB processing...`);
        const fileBuffer = await file.arrayBuffer();
        log(`[INFO] File read into buffer.`);

        const loader = new GLTFLoader();
        const gltf = await new Promise<any>((resolve, reject) => loader.parse(fileBuffer, '', resolve, reject));
        
        log(`[INFO] GLB parsed successfully. Analyzing model assets...`);
        
        const parser = gltf.parser;
        const json = parser.json;
        const scene = gltf.scene;

        const diffuseTextureSet = new Set<THREE.Texture>();
        scene.traverse((object: any) => {
            if (object.isMesh && object.material) {
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                materials.forEach(material => {
                    if ((material.isMeshStandardMaterial || material.isMeshBasicMaterial) && material.map) {
                        diffuseTextureSet.add(material.map);
                    }
                });
            }
        });
        
        log(`[INFO] Collecting textures for conversion...`);
        const newImageBuffers: { [index: number]: ArrayBuffer } = {};
        const textureSizeChanges: { name: string, originalSize: number, newSize: number, modified: boolean }[] = [];

        const oldBin = await parser.getDependency('buffer', 0);

        if (json.textures) {
            log(`[INFO] Found ${json.textures.length} textures.`);
            const texturePromises = json.textures.map(async (_: any, textureIndex: number) => {
                const texture = await parser.getDependency('texture', textureIndex);
                const textureDef = json.textures[textureIndex];
                const imageIndex = textureDef.source;
                const imageDef = json.images?.[imageIndex];
                if (!imageDef || imageDef.bufferView === undefined) return;

                const bufferViewDef = json.bufferViews[imageDef.bufferView];
                const originalBuffer = oldBin.slice(bufferViewDef.byteOffset || 0, (bufferViewDef.byteOffset || 0) + bufferViewDef.byteLength);
                const originalSize = originalBuffer.byteLength;
                
                const isDiffuse = diffuseTextureSet.has(texture);

                try {
                    let newBuffer = await processTexture(texture, isDiffuse, log, quality);
                    let modified = true;
                    if (imageDef.mimeType === 'image/png' && newBuffer.byteLength > originalSize) {
                         log(`   > Compressed size (${formatBytes(newBuffer.byteLength)}) is larger than original (${formatBytes(originalSize)}). Preserving original.`);
                        newBuffer = originalBuffer;
                        modified = false;
                    }
                    newImageBuffers[imageIndex] = newBuffer;
                    textureSizeChanges[imageIndex] = { name: texture.name || `Image ${imageIndex}`, originalSize, newSize: newBuffer.byteLength, modified };
                } catch(e) {
                    log(`[ERROR] Could not process texture '${texture.name || 'Untitled'}'. It will be preserved.`, 'error');
                    console.error(e);
                    textureSizeChanges[imageIndex] = { name: texture.name || `Image ${imageIndex}`, originalSize, newSize: originalSize, modified: false };
                }
            });

            await Promise.all(texturePromises);
        }

        log(`[SUCCESS] All textures processed. Re-packing GLB...`, 'success');

        const newJson = JSON.parse(JSON.stringify(json));
        const oldBufferViews = json.bufferViews;

        const viewIndexToImageIndex: { [viewIndex: number]: number } = {};
        if (json.images) {
            json.images.forEach((img: any, imgIndex: number) => {
                if (img.bufferView !== undefined) {
                    viewIndexToImageIndex[img.bufferView] = imgIndex;
                }
            });
        }
        
        const viewMetas = oldBufferViews.map((bv: any, i: number) => ({
            index: i,
            oldBv: bv,
            originalOffset: bv.byteOffset,
            isImage: viewIndexToImageIndex[i] !== undefined,
            imageIndex: viewIndexToImageIndex[i],
            sourceData: null as ArrayBuffer | null,
        }));
        
        let lastOffset = 0;
        let lastLength = 0;
        oldBufferViews.forEach((bv:any, i:number) => {
            const meta = viewMetas[i];
            if(meta.originalOffset === undefined) {
                meta.originalOffset = lastOffset + lastLength;
            }
            lastOffset = meta.originalOffset;
            lastLength = meta.oldBv.byteLength;
        });

        for(const meta of viewMetas) {
            if (meta.isImage && newImageBuffers[meta.imageIndex] !== undefined) {
                meta.sourceData = newImageBuffers[meta.imageIndex];
                newJson.images[meta.imageIndex].mimeType = 'image/png';
            } else {
                meta.sourceData = oldBin.slice(meta.originalOffset, meta.originalOffset + meta.oldBv.byteLength);
            }
        }
        
        viewMetas.sort((a, b) => a.originalOffset - b.originalOffset);

        log(`[INFO] --- Rebuilding binary chunk ---`);
        log(`[INFO] Pass 1: Calculating new layout...`);
        let newBinSize = 0;
        for (const meta of viewMetas) {
            const padding = (4 - (newBinSize % 4)) % 4;
            newBinSize += padding;
            
            newJson.bufferViews[meta.index].byteOffset = newBinSize;
            newJson.bufferViews[meta.index].byteLength = meta.sourceData!.byteLength;
            
            log(`[DEBUG] BV ${meta.index}: old offset: ${meta.oldBv.byteOffset}, new offset: ${newBinSize}, length: ${meta.sourceData!.byteLength}, padding: ${padding}`);
            
            newBinSize += meta.sourceData!.byteLength;
        }
        
        newJson.buffers[0].byteLength = newBinSize;
        log(`[INFO] Pass 1: New binary size: ${newBinSize} bytes`);

        log(`[INFO] Pass 2: Assembling new binary buffer...`);
        const newBinBuffer = new ArrayBuffer(newBinSize);
        const newBinBytes = new Uint8Array(newBinBuffer);

        for (const meta of viewMetas) {
            const newBv = newJson.bufferViews[meta.index];
            if (!meta.sourceData) {
                throw new Error(`Source data for bufferView ${meta.index} is missing.`);
            }
            log(`[DEBUG] BV ${meta.index}: Writing ${meta.sourceData!.byteLength} bytes at offset ${newBv.byteOffset}`);
            newBinBytes.set(new Uint8Array(meta.sourceData!), newBv.byteOffset);
        }
        
        const finalSize = newBinBytes.byteLength;
        if (finalSize !== newBinSize) {
             log(`[ERROR] Mismatch in binary chunk construction. Expected size: ${newBinSize}, Actual size: ${finalSize}`, 'error');
        } else {
             log(`[INFO] Pass 2: Assembly complete. Final size: ${finalSize} bytes.`);
        }
        
        const GLB_HEADER_MAGIC = 0x46546C67; // 'glTF'
        const GLB_VERSION = 2;
        const GLB_CHUNK_TYPE_JSON = 0x4E4F534A; // 'JSON'
        const GLB_CHUNK_TYPE_BIN = 0x004E4942; // 'BIN'

        const jsonString = JSON.stringify(newJson);
        const jsonBuffer = new TextEncoder().encode(jsonString);
        const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
        const jsonChunkLength = jsonBuffer.length + jsonPadding;
        
        const binPadding = (4 - (newBinBuffer.byteLength % 4)) % 4;
        const binChunkLength = newBinBuffer.byteLength + binPadding;
        
        const totalLength = 12 + (8 + jsonChunkLength) + (8 + binChunkLength);
        const finalGlbBuffer = new ArrayBuffer(totalLength);
        const dataView = new DataView(finalGlbBuffer);
        const uint8Array = new Uint8Array(finalGlbBuffer);

        let offset = 0;
        dataView.setUint32(offset, GLB_HEADER_MAGIC, true); offset += 4;
        dataView.setUint32(offset, GLB_VERSION, true); offset += 4;
        dataView.setUint32(offset, totalLength, true); offset += 4;

        // JSON chunk
        dataView.setUint32(offset, jsonChunkLength, true); offset += 4;
        dataView.setUint32(offset, GLB_CHUNK_TYPE_JSON, true); offset += 4;
        uint8Array.set(jsonBuffer, offset); offset += jsonBuffer.length;
        for(let i=0; i<jsonPadding; i++) uint8Array[offset++] = 0x20; 

        // BIN chunk
        dataView.setUint32(offset, binChunkLength, true); offset += 4;
        dataView.setUint32(offset, GLB_CHUNK_TYPE_BIN, true); offset += 4;
        uint8Array.set(new Uint8Array(newBinBuffer), offset); offset += newBinBuffer.byteLength;
        for(let i=0; i<binPadding; i++) uint8Array[offset++] = 0x00;
        
        log(`[SUCCESS] Export complete!`, 'success');
        
        log(`[INFO] --- Texture Size Report ---`);
        textureSizeChanges.forEach((change) => {
            if(!change) return;
            const status = change.modified ? '(modified)' : '(preserved)';
            log(`[INFO] '${change.name || 'Texture'}' ${status}: ${formatBytes(change.originalSize)} -> ${formatBytes(change.newSize)}`);
        });
        log(`[INFO] ---------------------------`);

        log(`[INFO] --- Total File Size ---`);
        log(`[INFO] Original Model: ${formatBytes(file.size)}`);
        log(`[INFO] New Model:      ${formatBytes(finalGlbBuffer.byteLength)}`);

        return new Blob([finalGlbBuffer], { type: 'model/gltf-binary' });
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        log(`[FATAL] An unexpected error occurred during GLB reconstruction: ${errorMessage}`, 'error');
        console.error(e);
        throw e;
    }
};