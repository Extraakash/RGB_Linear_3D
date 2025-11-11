
import React, { useEffect, useRef } from 'react';
import type { LogEntry } from '../types';

interface LoggerProps {
    logs: LogEntry[];
}

const Logger: React.FC<LoggerProps> = ({ logs }) => {
    const logContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
    }, [logs]);

    const getLogColor = (type: LogEntry['type']): string => {
        switch (type) {
            case 'success': return 'text-green-400';
            case 'error': return 'text-red-400';
            case 'warning': return 'text-yellow-400';
            case 'info':
            default: return 'text-gray-300';
        }
    };
    
    const getPrefix = (type: LogEntry['type']): string => {
         switch (type) {
            case 'success': return '[SUCCESS]';
            case 'error': return '[ERROR]';
            case 'warning': return '[WARN]';
            case 'info':
            default: return '[INFO]';
        }
    }

    return (
        <div ref={logContainerRef} className="p-4 font-mono text-sm bg-gray-900/50">
            {logs.length === 0 && <p className="text-gray-500">Waiting for file...</p>}
            {logs.map((log) => (
                <div key={log.id} className="flex">
                    <span className={`flex-shrink-0 w-24 ${getLogColor(log.type)}`}>{getPrefix(log.type)}</span>
                    <p className="flex-grow break-words whitespace-pre-wrap">{log.message}</p>
                </div>
            ))}
        </div>
    );
};

export default Logger;
