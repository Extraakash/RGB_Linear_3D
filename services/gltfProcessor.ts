
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { LogEntry } from '../types';

// Callback type for logging
type LogCallback = (message: string, type?: LogEntry['type']) => void;

/**
 * Inspects the first few bytes of an ArrayBuffer to determine the MIME type of an image.
 * @param buffer The ArrayBuffer containing the image data.
 * @returns The detected MIME type (e.g., 'image/png') or null if not recognized.
 */
const getImageMimeType = (buffer: ArrayBuffer): string | null => {
    const uint8 = new Uint8Array(buffer);

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        uint8.length > 8 &&
        uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4e &&
        uint8[3] === 0x47 && uint8[4] === 0x0d && uint8[5] === 0x0a &&
        uint8[6] === 0x1a && uint8[7] === 0x0a
    ) {
        return 'image/png';
    }

    // JPEG: FF D8 FF
    if (uint8.length > 2 && uint8[0] === 0xff && uint8[1] === 0xd8 && uint8[2] === 0xff) {
        return 'image/jpeg';
    }

    // WebP: RIFF .... WEBP
    if (
        uint8.length > 12 &&
        uint8[0] === 0x52 && uint8[1] === 0x49 && uint8[2] === 0x46 && uint8[3] === 0x46 &&
        uint8[8] === 0x57 && uint8[9] === 0x45 && uint8[10] === 0x42 && uint8[11] === 0x50
    ) {
        return 'image/webp';
    }

    return null;
};

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
    
            // We don't dispose the original texture, as it might be used by other
            // material properties (e.g. roughnessMap) that we are not modifying.
            // The GLTFExporter will handle packing only the textures that are
            // still referenced.
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
                    log('GLB parsed successfully. Analyzing model assets...');
                    const scene = gltf.scene;
                    const parser = gltf.parser;
                    const json = parser.json;

                    // --- Robust Texture Format Preservation ---
                    // Instead of traversing the scene and relying on the 'associations' map (which can be unreliable),
                    // we iterate directly through the GLTF manifest's texture definitions. This gives us a direct
                    // link between the texture data and the THREE.Texture object.
                    log('Attempting to preserve original texture formats...');
                    let restoredCount = 0;
                    let unknownCount = 0;
                    
                    if (json.textures && json.textures.length > 0) {
                        log(`Found ${json.textures.length} textures in the model manifest.`);
                        
                        const texturePromises = json.textures.map(async (_: any, index: number) => {
                            // Load the texture object using its index in the manifest
                            const texture = await parser.getDependency('texture', index) as THREE.Texture;
                            const textureDef = json.textures[index];
                            let mimeTypeFound = false;

                            if (textureDef.source === undefined) {
                                log(`   > Texture definition at index ${index} has no source image.`, 'warning');
                            } else {
                                const imageDef = json.images?.[textureDef.source];
                                if (!imageDef) {
                                    log(`   > Could not find image definition for texture at index ${index}.`, 'warning');
                                } else {
                                    const textureName = texture.name || `(index ${index})`;

                                    // Method 1: Check for MIME type in the GLTF manifest (most reliable)
                                    if (imageDef.mimeType) {
                                        (texture as any).mimeType = imageDef.mimeType;
                                        log(`   > Texture '${textureName}' format identified as ${imageDef.mimeType} from GLB manifest.`, 'info');
                                        restoredCount++;
                                        mimeTypeFound = true;
                                    }
                                    // Method 2: Check for embedded data URI
                                    else if (imageDef.uri?.startsWith('data:')) {
                                        const dataUriMimeType = imageDef.uri.substring(5, imageDef.uri.indexOf(';'));
                                        if (dataUriMimeType) {
                                            (texture as any).mimeType = dataUriMimeType;
                                            log(`   > Texture '${textureName}' format identified as ${dataUriMimeType} from data URI.`, 'info');
                                            restoredCount++;
                                            mimeTypeFound = true;
                                        }
                                    }
                                    // Method 3: If not found, inspect the raw image bytes via bufferView (fallback)
                                    else if (imageDef.bufferView !== undefined) {
                                        try {
                                            const bufferViewData = await parser.getDependency('bufferView', imageDef.bufferView);
                                            const detectedMimeType = getImageMimeType(bufferViewData);
                                            if (detectedMimeType) {
                                                (texture as any).mimeType = detectedMimeType;
                                                log(`   > Texture '${textureName}' format detected as ${detectedMimeType} by inspecting data.`, 'info');
                                                restoredCount++;
                                                mimeTypeFound = true;
                                            }
                                        } catch (e) {
                                            log(`   > Error inspecting buffer for texture '${textureName}': ${(e as Error).message}`, 'warning');
                                        }
                                    }
                                }
                            }

                            if (!mimeTypeFound) {
                                log(`   > Texture '${texture.name || `(index ${index})`}' format could not be determined. It will be exported as PNG.`, 'warning');
                                unknownCount++;
                            }
                        });
                        
                        await Promise.all(texturePromises);
                        
                        if (restoredCount > 0) {
                            log(`Successfully identified format for ${restoredCount} texture(s).`, 'info');
                        }
                        if (unknownCount > 0) {
                             log(`${unknownCount} texture(s) had no format specified in the GLB. Re-exporting them as PNG may change their file size.`, 'warning');
                        }
                    } else {
                        log('No textures found in the GLB manifest.', 'info');
                    }


                    log('Collecting diffuse textures for conversion...');
                    const uniqueTexturesToProcess = new Set<THREE.Texture>();

                    scene.traverse((object) => {
                        const mesh = object as THREE.Mesh;
                        if (!mesh.isMesh || !mesh.material) return;

                        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                        materials.forEach((material) => {
                            // We only want to process the main color/diffuse texture, which is the `.map` property
                            // on these material types. Other maps (normal, roughness, etc.) should be ignored.
                            if (
                                (material instanceof THREE.MeshStandardMaterial ||
                                 material instanceof THREE.MeshBasicMaterial ||
                                 material instanceof THREE.MeshLambertMaterial ||
                                 material instanceof THREE.MeshPhongMaterial) 
                                && material.map
                            ) {
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
                            if (
                                (material instanceof THREE.MeshStandardMaterial ||
                                 material instanceof THREE.MeshBasicMaterial ||
                                 material instanceof THREE.MeshLambertMaterial ||
                                 material instanceof THREE.MeshPhongMaterial) 
                                && material.map
                            ) {
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