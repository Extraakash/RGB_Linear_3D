
import React, { useState, useCallback } from 'react';
import type { LogEntry, ProcessingState, OptimizationLevel } from './types';
import { processGltf } from './services/gltfProcessor';
import Dropzone from './components/Dropzone';
import Logger from './components/Logger';
import { DownloadIcon, ErrorIcon, FileIcon, ResetIcon, SuccessIcon, ChevronDownIcon, ChevronUpIcon, UploadIcon, InfoIcon } from './components/icons';
import Tooltip from './components/Tooltip';

const App: React.FC = () => {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [processingState, setProcessingState] = useState<ProcessingState>('idle');
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const [fileName, setFileName] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [optimizationLevel, setOptimizationLevel] = useState<OptimizationLevel>('none');
    const [isLogVisible, setIsLogVisible] = useState<boolean>(false);
    const [originalSize, setOriginalSize] = useState<number>(0);
    const [processedSize, setProcessedSize] = useState<number>(0);

    const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
        setLogs(prev => [...prev, { id: Date.now() + Math.random(), message, type }]);
    }, []);

    const handleFileDrop = useCallback(async (file: File) => {
        if (!file || !file.name.toLowerCase().endsWith('.glb')) {
            addLog('Invalid file type. Please upload a .glb file.', 'error');
            return;
        }

        setProcessingState('processing');
        setLogs([]);
        setDownloadUrl(null);
        setError(null);
        setFileName(file.name);
        setOriginalSize(file.size);

        try {
            const processedBlob = await processGltf(file, addLog, optimizationLevel);
            const url = URL.createObjectURL(processedBlob);
            setDownloadUrl(url);
            setProcessedSize(processedBlob.size);
            setProcessingState('success');
            addLog('Processing successful! Your file is ready for download.', 'success');
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
            addLog(`Processing failed: ${errorMessage}`, 'error');
            setError(errorMessage);
            setProcessingState('error');
            console.error(err);
        }
    }, [addLog, optimizationLevel]);

    const handleReset = () => {
        setProcessingState('idle');
        setIsLogVisible(false);
        setLogs([]);
        if (downloadUrl) {
            URL.revokeObjectURL(downloadUrl);
        }
        setDownloadUrl(null);
        setError(null);
        setFileName('');
        setOriginalSize(0);
        setProcessedSize(0);
    };

    const getNewFileName = () => {
        const parts = fileName.split('.glb');
        return `${parts[0]}_linear.glb`;
    };

    const formatBytes = (bytes: number, decimals = 2) => {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    };

    const renderMainContent = () => {
        switch (processingState) {
            case 'idle':
                return (
                    <Dropzone onFileDrop={handleFileDrop} disabled={false}>
                        <div className="mt-6 w-full max-w-sm">
                            <div className="flex items-center justify-center space-x-2 mb-3">
                                <h3 className="text-sm font-medium text-gray-300">Texture Optimization</h3>
                                 <Tooltip text="All textures are converted to PNG. These options resize large textures and apply advanced color reduction (quantization) to significantly reduce PNG file size.">
                                     <InfoIcon className="w-4 h-4 text-gray-400" />
                                 </Tooltip>
                            </div>
                            <div className="flex justify-center space-x-2 bg-gray-900/50 p-1 rounded-lg">
                                {(['none', 'balanced', 'aggressive'] as OptimizationLevel[]).map((level) => (
                                     <button
                                         key={level}
                                         onClick={(e) => { e.stopPropagation(); setOptimizationLevel(level); }}
                                         className={`px-3 py-1 text-sm rounded-md transition-colors capitalize w-full ${optimizationLevel === level ? 'bg-cyan-500 text-white font-semibold' : 'bg-transparent text-gray-300 hover:bg-gray-700'}`}
                                     >
                                         {level}
                                     </button>
                                ))}
                            </div>
                        </div>
                    </Dropzone>
                );
            case 'processing':
                return (
                    <div className="flex flex-col items-center justify-center h-full text-center p-8">
                         <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-cyan-400 mb-4"></div>
                        <h3 className="text-xl font-semibold text-gray-200">Processing Model</h3>
                        <p className="text-gray-400 mt-2">Correcting gamma and optimizing textures. Please wait...</p>
                    </div>
                );
            case 'success':
                return (
                    <div className="flex flex-col items-center justify-center h-full text-center p-8 bg-green-900/20 rounded-lg">
                        <SuccessIcon className="w-16 h-16 text-green-400 mb-4" />
                        <h3 className="text-2xl font-bold text-green-300">Success!</h3>
                        <p className="text-gray-300 mt-2 mb-6">Your GLB file has been processed.</p>
                        
                        <div className="grid grid-cols-2 gap-4 w-full max-w-sm mb-8 text-center bg-gray-800/50 p-4 rounded-lg">
                            <div>
                                <div className="text-sm font-medium text-gray-400">Original Size</div>
                                <div className="text-lg font-semibold text-gray-200">{formatBytes(originalSize)}</div>
                            </div>
                            <div>
                                <div className="text-sm font-medium text-gray-400">New Size</div>
                                <div className="text-lg font-semibold text-gray-200">{formatBytes(processedSize)}</div>
                            </div>
                        </div>

                        <div className="flex items-center space-x-4">
                            <a
                                href={downloadUrl!}
                                download={getNewFileName()}
                                className="flex items-center justify-center px-6 py-3 bg-green-500 hover:bg-green-600 text-white font-bold rounded-md shadow-lg transition-transform transform hover:scale-105"
                            >
                                <DownloadIcon className="w-5 h-5 mr-2" />
                                Download
                            </a>
                            <button onClick={handleReset} className="flex items-center justify-center px-6 py-3 bg-gray-600 hover:bg-gray-700 text-white font-bold rounded-md transition-colors">
                               <UploadIcon className="w-5 h-5 mr-2"/>
                                Process Another
                            </button>
                        </div>
                    </div>
                );
            case 'error':
                 return (
                    <div className="flex flex-col items-center justify-center h-full text-center p-8 bg-red-900/20 rounded-lg">
                        <ErrorIcon className="w-16 h-16 text-red-400 mb-4" />
                        <h3 className="text-2xl font-bold text-red-300">Processing Failed</h3>
                        <p className="text-gray-300 mt-2 mb-6 max-w-md">{error}</p>
                         <button onClick={handleReset} className="flex items-center justify-center px-6 py-3 bg-gray-600 hover:bg-gray-700 text-white font-bold rounded-md transition-colors">
                            <ResetIcon className="w-5 h-5 mr-2"/>
                             Try Again
                         </button>
                    </div>
                 );
        }
    };

    return (
        <div className="min-h-screen flex flex-col p-4 sm:p-6 lg:p-8">
            <header className="text-center mb-8">
                <h1 className="text-4xl sm:text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-600">RGB to Linear Texture Converter</h1>
                <p className="mt-2 text-lg text-gray-400">Convert albedo textures from sRGB to Linear color space.</p>
            </header>

            <main className="flex-grow flex flex-col items-center">
                 <div className="w-full max-w-4xl bg-gray-800/50 rounded-xl border border-gray-700 shadow-2xl flex flex-col min-h-[500px]">
                    <div className="flex-grow flex items-center justify-center p-4">
                        {renderMainContent()}
                    </div>

                    {logs.length > 0 && (
                        <>
                            <div className="p-4 border-t border-gray-700 flex items-center justify-between flex-shrink-0">
                                <div className="flex items-center">
                                    <FileIcon className="w-5 h-5 mr-3 text-cyan-400"/>
                                    <h2 className="text-lg font-semibold text-gray-200">Processing Log</h2>
                                </div>
                                <button
                                    onClick={() => setIsLogVisible(!isLogVisible)}
                                    className="p-1 rounded-full hover:bg-gray-700 transition-colors text-gray-400 hover:text-white"
                                    aria-label={isLogVisible ? "Hide log" : "Show log"}
                                >
                                    {isLogVisible ? <ChevronUpIcon className="w-6 h-6"/> : <ChevronDownIcon className="w-6 h-6"/>}
                                </button>
                            </div>
                            <div className={`flex-grow-0 min-h-0 transition-[grid-template-rows] duration-300 ease-in-out grid ${isLogVisible ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                                <div className="overflow-hidden min-h-0 flex flex-col">
                                     <div className="max-h-64 overflow-y-auto">
                                        <Logger logs={logs} />
                                     </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </main>
            <footer className="text-center mt-8 text-gray-500 text-sm">
                <p>Powered by React, Three.js, and Tailwind CSS.</p>
            </footer>
        </div>
    );
};

export default App;