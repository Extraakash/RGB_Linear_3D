import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { LogEntry, OptimizationLevel } from '../types';
import * as UPNG from 'upng-js';

// Callback type for logging
type LogCallback = (message: string, type?: LogEntry['type']) => void;

type TextureInfo = {
    name: string;
    originalTexture: THREE.Texture;
    originalSize: number;
    newSize: number;
    mimeType?: string;
    isDiffuse: boolean;
};

const getUpngEncoder = (): ((...args: any[]) => ArrayBuffer) => {
    if (UPNG && typeof (UPNG as any).encode === 'function') {
        return (UPNG as any).encode;
    }
    if (UPNG && (UPNG as any).default && typeof (UPNG as any).default.encode === 'function') {
        return (UPNG as any).default.encode;
    }
    throw new Error('UPNG.js library is not loaded correctly. The encode function is missing.');
};

const formatBytes = (bytes: number, decimals = 2) => {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};


/**
 * Inspects the first few bytes of an ArrayBuffer to determine the MIME type of an image.
 */
const getImageMimeType = (buffer: ArrayBuffer): string | null => {
    const uint8 = new Uint8Array(buffer);
    if (uint8.length > 8 && uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4e && uint8[3] === 0x47) return 'image/png';
    if (uint8.length > 2 && uint8[0] === 0xff && uint8[1] === 0xd8 && uint8[2] === 0xff) return 'image/jpeg';
    if (uint8.length > 12 && uint8[0] === 0x52 && uint8[1] === 0x49 && uint8[2] === 0x46 && uint8[3] === 0x46 && uint8[8] === 0x57 && uint8[9] === 0x45 && uint8[10] === 0x42 && uint8[11] === 0x50) return 'image/webp';
    return null;
};

/**
 * Parses a GLB ArrayBuffer to extract the size of each embedded image.
 */
const getFinalTextureSizes = (glbBuffer: ArrayBuffer): number[] => {
    try {
        const dataView = new DataView(glbBuffer);
        if (dataView.getUint32(0, true) !== 0x46546C67) return [];

        const jsonChunkLength = dataView.getUint32(12, true);
        if (dataView.getUint32(16, true) !== 0x4E4F534A) return [];

        const jsonString = new TextDecoder('utf-8').decode(new Uint8Array(glbBuffer, 20, jsonChunkLength));
        const json = JSON.parse(jsonString);

        if (!json.images || !json.bufferViews) return [];
        return json.images.map((image: any) => json.bufferViews[image.bufferView]?.byteLength || 0);
    } catch (e) {
        console.error("Failed to parse final GLB for texture sizes:", e);
        return [];
    }
};

const correctGamma = (c: number): number => Math.pow(c / 255.0, 1.0 / 2.2) * 255.0;

const processTexture = (
    texture: THREE.Texture,
    log: LogCallback,
    optimizationLevel: OptimizationLevel,
    isDiffuse: boolean
): Promise<{ newTexture: THREE.Texture, newSize: number }> => {
    return new Promise((resolve, reject) => {
        const image = texture.image as any;
        const width = image.width || image.naturalWidth;
        const height = image.height || image.naturalHeight;
        
        if (!width || !height) {
            log(`Texture '${texture.name || 'Untitled'}' has no dimensions, skipping.`, 'warning');
            resolve({ newTexture: texture, newSize: 0 });
            return;
        }

        const canvas = document.createElement('canvas');
        let newWidth = width;
        let newHeight = height;
        let didResize = false;
        
        const exportMimeType = 'image/png';

        if (optimizationLevel === 'balanced' || optimizationLevel === 'aggressive') {
            if (Math.max(width, height) > 1024) {
                const ratio = 1024 / Math.max(width, height);
                newWidth = Math.max(1, Math.floor(width * ratio));
                newHeight = Math.max(1, Math.floor(height * ratio));
                didResize = true;
            }
        }

        canvas.width = newWidth;
        canvas.height = newHeight;

        if (didResize) {
            log(`   Resizing '${texture.name || 'Untitled'}' from ${width}x${height} to ${canvas.width}x${canvas.height}`, 'info');
        }
        
        const context = canvas.getContext('2d');
        if (!context) return reject(new Error('Could not get 2D context from canvas.'));

        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        
        try {
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            
            if (isDiffuse) {
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = correctGamma(data[i]);
                    data[i + 1] = correctGamma(data[i + 1]);
                    data[i + 2] = correctGamma(data[i + 2]);
                }
            }
            
            const encodePNG = getUpngEncoder();
            let pngBuffer: ArrayBuffer;
            if (optimizationLevel === 'none') {
                pngBuffer = encodePNG([imageData.data.buffer], canvas.width, canvas.height, 0);
            } else {
                const colorCount = optimizationLevel === 'balanced' ? 256 : 128;
                log(`   Optimizing PNG '${texture.name || 'Untitled'}' with ${colorCount}-color palette.`, 'info');
                pngBuffer = encodePNG([imageData.data.buffer], canvas.width, canvas.height, colorCount);
            }

            const blob = new Blob([pngBuffer], { type: exportMimeType });

            if (!blob) {
                log(`Could not create blob for texture '${texture.name || 'Untitled'}'.`, 'warning');
                resolve({ newTexture: texture, newSize: 0 }); // Fallback to original
                return;
            }

            const url = URL.createObjectURL(blob);
            const imageElement = new Image();
            
            imageElement.onload = () => {
                URL.revokeObjectURL(url);
                
                const newTexture = new THREE.Texture(imageElement);
                newTexture.name = texture.name || 'processed_texture';
                newTexture.flipY = texture.flipY;
                newTexture.wrapS = texture.wrapS;
                newTexture.wrapT = texture.wrapT;
                newTexture.magFilter = texture.magFilter;
                newTexture.anisotropy = texture.anisotropy;

                let newMinFilter = texture.minFilter;
                // FIX: Replaced array.includes() with direct comparisons to fix a TypeScript type error.
                const usesMipmaps = newMinFilter === THREE.LinearMipmapLinearFilter ||
                    newMinFilter === THREE.LinearMipmapNearestFilter ||
                    newMinFilter === THREE.NearestMipmapLinearFilter ||
                    newMinFilter === THREE.NearestMipmapNearestFilter;
                if (usesMipmaps) {
                    log(`Original texture '${texture.name}' uses mipmaps which cannot be preserved. Downgrading filter.`, 'warning');
                    newMinFilter = newMinFilter === THREE.LinearMipmapLinearFilter || newMinFilter === THREE.LinearMipmapNearestFilter ? THREE.LinearFilter : THREE.NearestFilter;
                }
                newTexture.minFilter = newMinFilter;
                newTexture.colorSpace = isDiffuse ? THREE.LinearSRGBColorSpace : texture.colorSpace;
                (newTexture as any).mimeType = exportMimeType;
                newTexture.needsUpdate = true;
        
                resolve({ newTexture, newSize: blob.size });
            };

            imageElement.onerror = (err) => {
                URL.revokeObjectURL(url);
                reject(new Error(`Failed to load processed image for texture '${texture.name || 'Untitled'}'. Error: ${err}`));
            };

            imageElement.src = url;

        } catch (e) {
            reject(new Error(`Could not process image data for '${texture.name || 'Untitled'}', possibly due to CORS. Error: ${(e as Error).message}`));
        }
    });
};

export const processGltf = (file: File, log: LogCallback, optimizationLevel: OptimizationLevel): Promise<Blob> => {
    return new Promise(async (resolve, reject) => {
        try {
            log('Starting GLB processing...');
            const loader = new GLTFLoader();
            const exporter = new GLTFExporter();
            const fileBuffer = await file.arrayBuffer();
            log('File read into buffer.');

            loader.parse(fileBuffer, '', async (gltf) => {
                try {
                    log('GLB parsed successfully. Analyzing model assets...');
                    const scene = gltf.scene;
                    const parser = gltf.parser;
                    const json = parser.json;
                    
                    const diffuseTextureSet = new Set<THREE.Texture>();
                    scene.traverse((object) => {
                        const mesh = object as THREE.Mesh;
                        if (!mesh.isMesh || !mesh.material) return;
                        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                        materials.forEach((material) => {
                            if ((material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial) && material.map) {
                                diffuseTextureSet.add(material.map);
                            }
                        });
                    });
                    
                    if (diffuseTextureSet.size > 0) {
                        log(`Found ${diffuseTextureSet.size} unique diffuse texture(s) for gamma correction.`);
                    } else {
                        log('No diffuse textures found for gamma correction.', 'info');
                    }
                    if (optimizationLevel !== 'none') {
                        log(`Applying '${optimizationLevel}' optimization to all textures.`, 'info');
                    }

                    const textureInfoList: TextureInfo[] = [];
                    const processedTextureMap = new Map<THREE.Texture, THREE.Texture>();

                    if (!json.textures || json.textures.length === 0) {
                        log('No textures found in the model. Nothing to process.', 'warning');
                        resolve(new Blob([fileBuffer], { type: 'model/gltf-binary' }));
                        return;
                    }
                    
                    const textureAnalysisPromises = json.textures.map(async (_: any, index: number) => {
                        const texture = await parser.getDependency('texture', index) as THREE.Texture;
                        const textureDef = json.textures[index];
                        const textureName = texture.name || `Texture ${index}`;
                        
                        let mimeType: string | undefined = undefined;
                        let originalSize = 0;
                        
                        if (textureDef.source !== undefined) {
                            const imageDef = json.images?.[textureDef.source];
                            if (imageDef) {
                                try {
                                    const bufferViewData = await parser.getDependency('bufferView', imageDef.bufferView);
                                    originalSize = bufferViewData.byteLength;
                                    mimeType = imageDef.mimeType || getImageMimeType(bufferViewData) || undefined;
                                } catch (e) { /* ignore */ }
                            }
                        }
                        
                        if (mimeType) (texture as any).mimeType = mimeType;

                        textureInfoList[index] = {
                            name: textureName,
                            originalTexture: texture,
                            originalSize,
                            newSize: originalSize,
                            mimeType,
                            isDiffuse: diffuseTextureSet.has(texture),
                        };
                    });
                    await Promise.all(textureAnalysisPromises);

                    log(`Beginning processing for ${textureInfoList.length} total textures...`);
                    const processingPromises = textureInfoList.map(async (info) => {
                        const { newTexture } = await processTexture(info.originalTexture, log, optimizationLevel, info.isDiffuse);
                        processedTextureMap.set(info.originalTexture, newTexture);
                    });
                    await Promise.all(processingPromises);
                    log('All textures processed.', 'success');
                    
                    log('Applying new textures to materials...', 'info');
                    scene.traverse((object) => {
                        const mesh = object as THREE.Mesh;
                        if (!mesh.isMesh || !mesh.material) return;
                        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                        materials.forEach((material) => {
                            for (const key in material) {
                                if (material[key as keyof typeof material] instanceof THREE.Texture) {
                                    const originalTexture = material[key as keyof typeof material] as THREE.Texture;
                                    if (processedTextureMap.has(originalTexture)) {
                                        (material[key as keyof typeof material] as any) = processedTextureMap.get(originalTexture)!;
                                    }
                                }
                            }
                            material.needsUpdate = true;
                        });
});

                    log('Exporting to new GLB file...');
                    exporter.parse(scene, (result) => {
                        if (result instanceof ArrayBuffer) {
                            log('Export complete!', 'success');
                            const blob = new Blob([result], { type: 'model/gltf-binary' });

                            const finalTextureSizes = getFinalTextureSizes(result);
                            if (finalTextureSizes.length === textureInfoList.length) {
                                textureInfoList.forEach((info, index) => {
                                    info.newSize = finalTextureSizes[index];
                                });
                            }

                            if (textureInfoList.length > 0) {
                                log('--- Texture Size Report ---', 'info');
                                for (const info of textureInfoList) {
                                    const oldSizeStr = formatBytes(info.originalSize);
                                    const newSizeStr = formatBytes(info.newSize);
                                    const status = info.isDiffuse ? '(modified)' : '(re-compressed)';
                                    log(`'${info.name}' ${status}: ${oldSizeStr} -> ${newSizeStr}`, 'info');
                                }
                                log('---------------------------', 'info');
                            }

                            log('--- Total File Size ---', 'info');
                            log(`Original Model: ${formatBytes(file.size)}`, 'info');
                            log(`New Model:      ${formatBytes(blob.size)}`, 'info');
                            log('-----------------------', 'info');

                            resolve(blob);
                        } else {
                           reject(new Error('Exporter did not return an ArrayBuffer.'));
                        }
                    }, (error) => { reject(error); }, { binary: true, embedImages: true });

                } catch (e) { reject(e); }
            }, (error) => { reject(error); });
        } catch (e) {
            log(`An unexpected error occurred: ${(e as Error).message}`, 'error');
            reject(e);
        }
    });
};