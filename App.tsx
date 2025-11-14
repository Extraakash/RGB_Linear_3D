
import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { LogEntry, ProcessingState } from './types';
import { processGltf } from './services/gltfProcessor';
import Logger from './components/Logger';
import Dropzone from './components/Dropzone';
import Tooltip from './components/Tooltip';
import { DownloadIcon, ErrorIcon, FileIcon, ResetIcon, SuccessIcon, ChevronDownIcon, ChevronUpIcon, InfoIcon, PlusIcon } from './components/icons';

const formatBytes = (bytes: number, decimals = 2) => {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

const App: React.FC = () => {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [processingState, setProcessingState] = useState<ProcessingState>('idle');
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const [fileName, setFileName] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [isLogVisible, setIsLogVisible] = useState<boolean>(false);
    const [originalSize, setOriginalSize] = useState<number>(0);
    const [processedSize, setProcessedSize] = useState<number>(0);
    const [compressionQuality, setCompressionQuality] = useState<number>(90);
    const logContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
    }, [logs]);

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
        setFileName(file.name);
        setOriginalSize(file.size);

        try {
            const quality = compressionQuality;
            addLog(`PNG compression enabled with quality ${quality === 100 ? 'lossless' : quality}.`);
            const processedBlob = await processGltf(file, addLog, quality);
            const url = URL.createObjectURL(processedBlob);
            setDownloadUrl(url);
            setProcessedSize(processedBlob.size);
            setProcessingState('success');
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
            addLog(errorMessage, 'error');
            setError(errorMessage);
            setProcessingState('error');
        }
    }, [addLog, compressionQuality]);

    const handleReset = () => {
        setProcessingState('idle');
        setIsLogVisible(false);
        setLogs([]);
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
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

    const renderMainContent = () => {
        switch (processingState) {
            case 'idle':
                return (
                    <Dropzone onFileDrop={handleFileDrop} disabled={processingState !== 'idle'}>
                        <div className="w-full max-w-sm mx-auto space-y-2" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-center space-x-2">
                                <label htmlFor="quality-slider" className="text-sm font-medium text-gray-400">
                                    Compression Quality
                                </label>
                                <Tooltip text="Controls the quality of processed PNG textures. 100 is lossless, lower values offer more compression.">
                                    <InfoIcon className="w-5 h-5 text-gray-500"/>
                                </Tooltip>
                            </div>
                            <div className="flex items-center space-x-4">
                                <input
                                    id="quality-slider"
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={compressionQuality}
                                    onChange={(e) => setCompressionQuality(parseInt(e.target.value, 10))}
                                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                    disabled={processingState !== 'idle'}
                                    aria-label="PNG compression quality"
                                />
                                <span className="text-cyan-400 font-mono w-24 text-center">
                                    {compressionQuality === 100 ? 'Lossless' : `${compressionQuality}`}
                                </span>
                            </div>
                        </div>
                    </Dropzone>
                );
            case 'processing':
                return (
                    <div className="flex flex-col items-center justify-center text-center p-8">
                        <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-cyan-400 mb-4"></div>
                        <h3 className="text-xl font-semibold text-gray-200">Processing Model</h3>
                        <p className="text-gray-400 mt-2">Applying gamma correction & PNG compression...</p>
                    </div>
                );
            case 'success':
                return (
                    <div className="flex flex-col items-center justify-center text-center p-8 bg-green-900/20 rounded-lg">
                        <SuccessIcon className="w-16 h-16 text-green-400 mb-4" />
                        <h3 className="text-2xl font-bold text-green-300">Success!</h3>
                        <p className="text-gray-300 mt-2 mb-6">Your GLB file has been processed.</p>
                         <div className="text-lg text-gray-300 mb-6 font-mono">
                            {formatBytes(originalSize)} → {formatBytes(processedSize)}
                        </div>
                        <div className="flex items-center space-x-4">
                            <a href={downloadUrl!} download={getNewFileName()} className="flex items-center justify-center px-6 py-3 bg-green-500 hover:bg-green-600 text-white font-bold rounded-md shadow-lg transition-transform transform hover:scale-105">
                                <DownloadIcon className="w-5 h-5 mr-2" />
                                Download
                            </a>
                            <button onClick={handleReset} className="flex items-center justify-center px-6 py-3 bg-gray-600 hover:bg-gray-700 text-white font-bold rounded-md transition-colors">
                                <PlusIcon className="w-5 h-5 mr-2"/>
                                Process Another
                            </button>
                        </div>
                    </div>
                );
            case 'error':
                 return (
                    <div className="flex flex-col items-center justify-center text-center p-8 bg-red-900/20 rounded-lg">
                        <ErrorIcon className="w-16 h-16 text-red-400 mb-4" />
                        <h3 className="text-2xl font-bold text-red-300">An Error Occurred</h3>
                        <p className="text-gray-300 mt-2 mb-6 max-w-md">{error}</p>
                         <button onClick={handleReset} className="flex items-center justify-center px-6 py-3 bg-gray-600 hover:bg-gray-700 text-white font-bold rounded-md transition-colors">
                            <ResetIcon className="w-5 h-5 mr-2"/>
                             Try Again
                         </button>
                    </div>
                 );
        }
    };
    
    const contentWrapperClasses = ['success', 'error', 'processing'].includes(processingState)
        ? 'flex-grow flex flex-col items-center justify-center p-4'
        : 'flex-grow flex items-stretch justify-center p-4';

    return (
        <div className="min-h-screen flex flex-col">
            <main className="flex-grow flex flex-col items-center justify-center">
                 <div className="w-full max-w-4xl bg-gray-800/50 rounded-xl border border-gray-700 shadow-2xl flex flex-col min-h-[80vh]">
                    <div className={contentWrapperClasses}>
                        {renderMainContent()}
                    </div>

                    {logs.length > 0 && (
                        <>
                            <div className="p-4 border-t border-gray-700 flex items-center justify-between">
                                <div className="flex items-center">
                                    <FileIcon className="w-5 h-5 mr-3 text-cyan-400"/>
                                    <h2 className="text-lg font-semibold text-gray-200">Processing Log</h2>
                                </div>
                                <button onClick={() => setIsLogVisible(!isLogVisible)} className="p-1 rounded-full hover:bg-gray-700 transition-colors text-gray-400 hover:text-white" aria-label={isLogVisible ? 'Collapse log' : 'Expand log'}>
                                    {isLogVisible ? <ChevronUpIcon className="w-6 h-6"/> : <ChevronDownIcon className="w-6 h-6"/>}
                                </button>
                            </div>
                            <div ref={logContainerRef} className={`transition-all duration-300 ${isLogVisible ? 'max-h-64' : 'max-h-0'} overflow-y-auto`}>
                                <div className="border-t border-gray-700">
                                    <Logger logs={logs} />
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </main>
        </div>
    );
};

export default App;
