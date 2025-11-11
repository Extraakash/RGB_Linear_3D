
import React, { useState } from 'react';

interface TooltipProps {
    children: React.ReactElement;
    text: string;
}

const Tooltip: React.FC<TooltipProps> = ({ children, text }) => {
    const [visible, setVisible] = useState(false);

    return (
        <div 
            className="relative flex items-center"
            onMouseEnter={() => setVisible(true)}
            onMouseLeave={() => setVisible(false)}
        >
            {children}
            {visible && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2 bg-gray-900 text-white text-xs rounded-md shadow-lg border border-gray-700 z-10">
                    {text}
                    <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-gray-900"></div>
                </div>
            )}
        </div>
    );
};

export default Tooltip;
