// Helper utilities to export JSON data to CSV and JSON files in browser

export function downloadJSON(data, filename = 'export.json') {
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

export function downloadCSV(dataArray, filename = 'export.csv') {
    if (!Array.isArray(dataArray) || dataArray.length === 0) return;
    
    // Extract headers
    const headers = Object.keys(dataArray[0]);
    const csvRows = [];
    
    // Header row
    csvRows.push(headers.join(','));
    
    // Data rows
    for (const row of dataArray) {
        const values = headers.map(header => {
            const val = row[header] === null || row[header] === undefined ? '' : String(row[header]);
            const escaped = val.replace(/"/g, '""');
            return `"${escaped}"`;
        });
        csvRows.push(values.join(','));
    }
    
    const csvString = '\uFEFF' + csvRows.join('\n'); // Add BOM for Excel UTF-8 support
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
