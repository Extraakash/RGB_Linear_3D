
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { LogEntry } from '../types';

// Callback type for logging
type LogCallback = (message: string, type?: LogEntry['type']) => void;

// The user reported that the sRGB to Linear conversion (gamma ~2.2) resulted
// in a darker image, which was the opposite of the desired effect. This
// inverse correction (gamma of 1.0 / 2.2) is being applied to make the image
// brighter, matching the user's expectation. This is technically a Linear to
// sRGB conversion.
const correctGamma = (c: number): number => {
    const v = c / 255.0;
    return Math.pow(v, 1.0 / 2.2) * 255.0;
};

const processTexture = (texture: THREE.Texture, log: LogCallback, usePngCompression: boolean): Promise<THREE.Texture> => {
    return new Promise((resolve, reject) => {
        if (!texture.image) {
            log('Texture has no image data, skipping.', 'warning');
            resolve(texture);
            return;
        }
        
        const image = texture.image as any; // Cast to any to handle different image types

        // Image sources for canvas can be HTMLImageElement, SVGImageElement, HTMLVideoElement,
        // HTMLCanvasElement, ImageBitmap, OffscreenCanvas. They all have width and height.
        const width = image.width || image.naturalWidth || image.videoWidth;
        const height = image.height || image.naturalHeight || image.videoHeight;
        
        if (!width || !height) {
            log('Texture image source has no dimensions, skipping.', 'warning');
            resolve(texture);
            return;
        }

        const canvas = document.createElement('canvas');
        
        // "Compress PNG" by reducing resolution by 50%
        const scale = usePngCompression ? 0.5 : 1.0;
        canvas.width = Math.max(1, Math.floor(width * scale));
        canvas.height = Math.max(1, Math.floor(height * scale));

        if (usePngCompression) {
            log(`   Compressing: Resizing texture to ${canvas.width}x${canvas.height}`, 'info');
        }
        
        const context = canvas.getContext('2d');
        if (!context) {
            return reject(new Error('Could not get 2D context from canvas.'));
        }

        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        
        try {
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
    
            for (let i = 0; i < data.length; i += 4) {
                data[i] = correctGamma(data[i]);       // R
                data[i + 1] = correctGamma(data[i + 1]); // G
                data[i + 2] = correctGamma(data[i + 2]); // B
                // Alpha channel (data[i + 3]) is left unchanged
            }
    
            context.putImageData(imageData, 0, 0);
    
            const newTexture = new THREE.CanvasTexture(canvas);
            
            // Copy all relevant properties from the old texture to prevent rendering artifacts
            newTexture.name = texture.name ? `${texture.name}_linear` : 'linear_texture';
            newTexture.flipY = texture.flipY;
            newTexture.wrapS = texture.wrapS;
            newTexture.wrapT = texture.wrapT;
            newTexture.magFilter = texture.magFilter;
            newTexture.anisotropy = texture.anisotropy;

            // Mipmaps are not generated for the CanvasTexture in this context. If the original
            // texture's minFilter relied on mipmaps, it can cause corruption. We downgrade the
            // filter to a non-mipmap equivalent to prevent this.
            let newMinFilter = texture.minFilter;
            const usesMipmaps =
                newMinFilter === THREE.LinearMipmapLinearFilter ||
                newMinFilter === THREE.LinearMipmapNearestFilter ||
                newMinFilter === THREE.NearestMipmapLinearFilter ||
                newMinFilter === THREE.NearestMipmapNearestFilter;

            if (usesMipmaps) {
                log(`Original texture uses mipmaps which cannot be preserved. Downgrading texture filter to prevent corruption.`, 'warning');
                if (newMinFilter === THREE.LinearMipmapLinearFilter || newMinFilter === THREE.LinearMipmapNearestFilter) {
                     newMinFilter = THREE.LinearFilter;
                } else {
                     newMinFilter = THREE.NearestFilter;
                }
            }
            newTexture.minFilter = newMinFilter;

            newTexture.colorSpace = THREE.LinearSRGBColorSpace;
    
            texture.dispose(); 
            resolve(newTexture);

        } catch (e) {
            // This can happen due to tainted canvas from CORS
            const error = new Error(`Could not process image data, possibly due to CORS policy. Error: ${(e as Error).message}`);
            log(error.message, 'error');
            reject(error);
        }
    });
};


export const processGltf = (file: File, log: LogCallback, usePngCompression: boolean): Promise<Blob> => {
    return new Promise(async (resolve, reject) => {
        try {
            log('Starting GLB processing...');
            const loader = new GLTFLoader();
            const exporter = new GLTFExporter();
            const fileBuffer = await file.arrayBuffer();
            log('File read into buffer.');

            loader.parse(fileBuffer, '', async (gltf) => {
                try {
                    log('GLB parsed successfully. Collecting textures...');
                    const scene = gltf.scene;
                    const uniqueTexturesToProcess = new Set<THREE.Texture>();

                    scene.traverse((object) => {
                        const mesh = object as THREE.Mesh;
                        if (!mesh.isMesh || !mesh.material) return;

                        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                        materials.forEach((material) => {
                            if (material instanceof THREE.MeshStandardMaterial && material.map) {
                                uniqueTexturesToProcess.add(material.map);
                            }
                        });
                    });

                    if (uniqueTexturesToProcess.size === 0) {
                        log('No diffuse/albedo textures found to process.', 'warning');
                        // No textures to process, resolve with the original file data.
                        resolve(new Blob([fileBuffer], { type: 'model/gltf-binary' }));
                        return;
                    }

                    log(`Found ${uniqueTexturesToProcess.size} unique texture(s) to process.`);
                    
                    const processedTextureMap = new Map<THREE.Texture, THREE.Texture>();
                    const processingPromises = Array.from(uniqueTexturesToProcess).map(async (texture) => {
                        log(`Processing texture: ${texture.name || 'Untitled'}`, 'info');
                        const newTexture = await processTexture(texture, log, usePngCompression);
                        processedTextureMap.set(texture, newTexture);
                    });

                    await Promise.all(processingPromises);
                    log('All textures processed. Applying new textures to materials...', 'success');

                    scene.traverse((object) => {
                        const mesh = object as THREE.Mesh;
                        if (!mesh.isMesh || !mesh.material) return;
                        
                        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                        materials.forEach((material) => {
                            if (material instanceof THREE.MeshStandardMaterial && material.map) {
                                if (processedTextureMap.has(material.map)) {
                                    material.map = processedTextureMap.get(material.map)!;
                                    material.needsUpdate = true;
                                }
                            }
                        });
                    });

                    log('Exporting to new GLB file...');
                    exporter.parse(scene, (result) => {
                        if (result instanceof ArrayBuffer) {
                            log('Export complete!', 'success');
                            const blob = new Blob([result], { type: 'model/gltf-binary' });
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
