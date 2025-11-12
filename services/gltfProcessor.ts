
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

const correctGamma = (c: number): number => Math.pow(c, 2.2);

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
        const srgbToLinear = new Uint8Array(256);
        for(let i=0; i<256; i++) srgbToLinear[i] = Math.floor(correctGamma(i/255)*255);

        for (let i = 0; i < data.length; i += 4) {
            data[i] = srgbToLinear[data[i]];
            data[i + 1] = srgbToLinear[data[i + 1]];
            data[i + 2] = srgbToLinear[data[i + 2]];
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
                        material.map.colorSpace = THREE.LinearSRGBColorSpace;
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
            byteOffset: bv.byteOffset || 0,
            isImage: viewIndexToImageIndex[i] !== undefined,
            imageIndex: viewIndexToImageIndex[i],
            sourceData: null as ArrayBuffer | null,
        }));
        
        viewMetas.sort((a, b) => a.byteOffset - b.byteOffset);

        log(`[INFO] --- Rebuilding binary chunk ---`);
        log(`[INFO] Pass 1: Calculating new layout...`);
        let newBinSize = 0;
        for (const meta of viewMetas) {
            const oldBv = oldBufferViews[meta.index];
            const offset = oldBv.byteOffset || 0;
            let data: ArrayBuffer;
            if (meta.isImage && newImageBuffers[meta.imageIndex] !== undefined) {
                data = newImageBuffers[meta.imageIndex];
                newJson.images[meta.imageIndex].mimeType = 'image/png';
            } else {
                data = oldBin.slice(offset, offset + oldBv.byteLength);
            }
            meta.sourceData = data;

            const padding = (4 - (newBinSize % 4)) % 4;
            newBinSize += padding;
            
            newJson.bufferViews[meta.index].byteOffset = newBinSize;
            newJson.bufferViews[meta.index].byteLength = data.byteLength;
            
            log(`[DEBUG] BV ${meta.index}: old offset: ${oldBv.byteOffset}, new offset: ${newBinSize}, length: ${data.byteLength}, padding: ${padding}`);
            
            newBinSize += data.byteLength;
        }
        
        newJson.buffers[0].byteLength = newBinSize;
        log(`[INFO] Pass 1: New binary size: ${newBinSize} bytes`);

        log(`[INFO] Pass 2: Assembling new binary buffer...`);
        const newBinBuffer = new ArrayBuffer(newBinSize);
        const newBinBytes = new Uint8Array(newBinBuffer);
        let currentOffset = 0;
        for (const meta of viewMetas) {
            const padding = (4 - (currentOffset % 4)) % 4;
            currentOffset += padding;
            
            if (!meta.sourceData) {
                throw new Error(`Source data for bufferView ${meta.index} is missing.`);
            }
            log(`[DEBUG] BV ${meta.index}: Writing ${meta.sourceData!.byteLength} bytes at offset ${currentOffset}`);
            newBinBytes.set(new Uint8Array(meta.sourceData!), currentOffset);
            currentOffset += meta.sourceData!.byteLength;
        }
        
        if (currentOffset !== newBinSize) {
             log(`[ERROR] Mismatch in binary chunk construction. Expected size: ${newBinSize}, Actual size: ${currentOffset}`, 'error');
        } else {
             log(`[INFO] Pass 2: Assembly complete. Final size: ${currentOffset} bytes.`);
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
        log(`[FATAL] An unexpected error occurred during GLB reconstruction: ${e.message}`, 'error');
        console.error(e);
        throw e;
    }
};