
import React, { useState, useCallback } from 'react';
import { UploadIcon } from './icons';

interface DropzoneProps {
    onFileDrop: (file: File) => void;
    disabled: boolean;
    children?: React.ReactNode;
}

const Dropzone: React.FC<DropzoneProps> = ({ onFileDrop, disabled, children }) => {
    const [isDragging, setIsDragging] = useState(false);

    const handleDrag = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) {
            if (e.type === 'dragenter' || e.type === 'dragover') {
                setIsDragging(true);
            } else if (e.type === 'dragleave') {
                setIsDragging(false);
            }
        }
    }, [disabled]);

    const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        if (!disabled && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            onFileDrop(e.dataTransfer.files[0]);
            e.dataTransfer.clearData();
        }
    }, [disabled, onFileDrop]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            onFileDrop(e.target.files[0]);
        }
    };
    
    const baseClasses = "relative flex flex-col items-center justify-center w-full h-full p-8 text-center border-2 border-dashed rounded-lg transition-colors duration-300";
    const idleClasses = "border-gray-600 hover:border-cyan-400 hover:bg-gray-800/60 cursor-pointer";
    const draggingClasses = "border-cyan-400 bg-cyan-900/30";
    const disabledClasses = "border-gray-700 bg-gray-800/20 cursor-not-allowed opacity-50";

    const getDynamicClasses = () => {
        if (disabled) return disabledClasses;
        if (isDragging) return draggingClasses;
        return idleClasses;
    }

    return (
        <div 
            className={`${baseClasses} ${getDynamicClasses()}`}
            onDragEnter={handleDrag}
            onDragOver={handleDrag}
            onDragLeave={handleDrag}
            onDrop={handleDrop}
            onClick={() => !disabled && document.getElementById('fileInput')?.click()}
        >
             <input 
                type="file" 
                id="fileInput" 
                className="hidden" 
                accept=".glb"
                onChange={handleFileChange} 
                disabled={disabled}
            />
            <div>
                <div className="flex flex-col items-center pointer-events-none">
                    <UploadIcon className="w-16 h-16 mb-4 text-gray-500" />
                    <p className="text-xl font-semibold text-gray-200">Drag & drop a .glb file here</p>
                    <p className="text-gray-400 mt-1">or click to select a file</p>
                </div>
                
                {children}

                <p className="text-xs text-gray-500 mt-6 pointer-events-none">All processing is done in your browser. Your files are never uploaded.</p>
            </div>
        </div>
    );
};

export default Dropzone;