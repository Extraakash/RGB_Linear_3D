
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { LogEntry } from '../types';

type LogCallback = (message: string, type?: LogEntry['type']) => void;

const formatBytes = (bytes: number, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const getImageMimeType = (buffer: ArrayBuffer): string | null => {
    const uint8 = new Uint8Array(buffer);
    if (uint8.length > 8 && uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4e && uint8[3] === 0x47) return 'image/png';
    if (uint8.length > 2 && uint8[0] === 0xff && uint8[1] === 0xd8 && uint8[2] === 0xff) return 'image/jpeg';
    if (uint8.length > 12 && uint8[0] === 0x52 && uint8[1] === 0x49 && uint8[2] === 0x46 && uint8[3] === 0x46 && uint8[8] === 0x57 && uint8[9] === 0x45 && uint8[10] === 0x42 && uint8[11] === 0x50) return 'image/webp';
    return null;
};

const correctGamma = (c: number): number => Math.pow(c, 2.2);

async function processTexture(
    texture: THREE.Texture,
    isDiffuse: boolean,
    mimeType: string | null,
    log: LogCallback
): Promise<{ texture: THREE.Texture, size: number }> {
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

    const newMimeType: string = mimeType || 'image/png';
    const canvasBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, newMimeType));
    if (!canvasBlob) throw new Error('Failed to create blob from canvas.');
    const blob = canvasBlob;

    const newTexture = texture.clone();
    newTexture.image = await createImageBitmap(blob);
    (newTexture as any).mimeType = newMimeType;
    newTexture.needsUpdate = true;

    if (isDiffuse) {
        newTexture.colorSpace = THREE.LinearSRGBColorSpace;
    }

    return { texture: newTexture, size: blob.size };
}


export const processGltf = async (file: File, log: LogCallback): Promise<Blob> => {
    log(`Starting GLB processing...`);
    const fileBuffer = await file.arrayBuffer();
    log(`[INFO] File read into buffer.`);

    const loader = new GLTFLoader();
    const gltf = await new Promise<any>((resolve, reject) => loader.parse(fileBuffer, '', resolve, reject));
    
    log(`[INFO] GLB parsed successfully. Analyzing model assets...`);
    
    const parser = gltf.parser;
    const json = parser.json;
    const scene = gltf.scene;

    const originalTextures: { texture: THREE.Texture, mimeType: string | null, originalSize: number }[] = [];
    if (json.textures) {
        log(`[INFO] Attempting to preserve original texture formats...`);
        const texturePromises = json.textures.map(async (_: any, index: number) => {
            const texture = await parser.getDependency('texture', index);
            const textureDef = json.textures[index];
            const imageDef = json.images?.[textureDef.source];
            if (!imageDef) return null;
            
            const bufferViewData = await parser.getDependency('bufferView', imageDef.bufferView);
            const mimeType = imageDef.mimeType || getImageMimeType(bufferViewData);
            
            if (mimeType) {
                log(`   > Texture '${texture.name || `(index ${index})`}' format identified as ${mimeType} from GLB manifest.`);
            } else {
                log(`   > [WARN] Texture '${texture.name || `(index ${index})`}' format could not be determined. It will be exported as PNG.`, 'warning');
            }
            return { texture, mimeType, originalSize: bufferViewData.byteLength };
        });
        const results = (await Promise.all(texturePromises)).filter(Boolean);
        originalTextures.push(...results as any[]);
        log(`[INFO] Successfully identified format for ${results.length} texture(s).`);
    }

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
    const textureMap = new Map<THREE.Texture, THREE.Texture>();
    const textureSizeChanges: { name: string, originalSize: number, newSize: number, modified: boolean }[] = [];

    const textureProcessingPromises = originalTextures.map(async ({ texture, mimeType, originalSize }) => {
        const isDiffuse = diffuseTextureSet.has(texture);
        const shouldProcess = isDiffuse;
        
        if (shouldProcess) {
             try {
                const { texture: newTexture, size: newSize } = await processTexture(texture, isDiffuse, mimeType, log);
                textureMap.set(texture, newTexture);
                textureSizeChanges.push({ name: texture.name || 'Untitled', originalSize, newSize, modified: true });
            } catch(e) {
                log(`[ERROR] Could not process texture '${texture.name || 'Untitled'}'. It will be skipped.`, 'error');
                console.error(e);
                textureSizeChanges.push({ name: texture.name || 'Untitled', originalSize, newSize: originalSize, modified: false });
            }
        } else {
            textureSizeChanges.push({ name: texture.name || 'Untitled', originalSize, newSize: originalSize, modified: false });
        }
    });

    await Promise.all(textureProcessingPromises);

    log(`[SUCCESS] All textures processed. Applying new textures to materials...`, 'success');

    const clonedScene = scene.clone(true);
    clonedScene.traverse((object: any) => {
        if (object.isMesh && object.material) {
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            object.material = materials.length > 1 ? [] : undefined;

            materials.forEach(material => {
                const newMaterial = material.clone();
                for (const key in newMaterial) {
                    if (newMaterial[key as keyof typeof newMaterial] instanceof THREE.Texture) {
                         const originalTexture = newMaterial[key as keyof typeof newMaterial] as THREE.Texture;
                         if(textureMap.has(originalTexture)) {
                            (newMaterial as any)[key] = textureMap.get(originalTexture);
                         }
                    }
                }
                if (Array.isArray(object.material)) {
                    object.material.push(newMaterial);
                } else {
                    object.material = newMaterial;
                }
            });
        }
    });

    log(`[INFO] Exporting to new GLB file...`);
    const exporter = new GLTFExporter();
    const result = await new Promise<ArrayBuffer>((resolve, reject) => {
        exporter.parse(clonedScene, (result) => {
            if (result instanceof ArrayBuffer) {
                resolve(result);
            } else {
                reject('Exporter did not return ArrayBuffer');
            }
        }, (error) => reject(error), { binary: true, embedImages: true });
    });
    
    log(`[SUCCESS] Export complete!`, 'success');
    
    // Final report generation from the exported file for accuracy
    const finalGltf = await new Promise<any>((resolve, reject) => loader.parse(result.slice(0), '', resolve, reject));
    const finalParser = finalGltf.parser;
    const finalJson = finalParser.json;
    
    if (finalJson.images) {
        const finalSizePromises = finalJson.images.map(async (imgDef: any, index: number) => {
            try {
                const bufferViewData = await finalParser.getDependency('bufferView', imgDef.bufferView);
                return bufferViewData.byteLength;
            } catch { return 0; }
        });
        const finalSizes = await Promise.all(finalSizePromises);
        
        log(`[INFO] --- Texture Size Report ---`);
        textureSizeChanges.forEach((change, i) => {
            const finalSize = finalSizes[i] || change.newSize; // Fallback for safety
            const status = change.modified ? '(modified)' : '(re-compressed)';
            log(`[INFO] '${change.name || `Texture ${i}`}' ${status}: ${formatBytes(change.originalSize)} -> ${formatBytes(finalSize)}`);
        });
        log(`[INFO] ---------------------------`);
    }

    log(`[INFO] --- Total File Size ---`);
    log(`[INFO] Original Model: ${formatBytes(file.size)}`);
    log(`[INFO] New Model:      ${formatBytes(result.byteLength)}`);

    return new Blob([result], { type: 'model/gltf-binary' });
};