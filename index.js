const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const app = express();

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Add request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

require('dotenv').config();
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PORT = process.env.PORT || 3000;

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'File Transfer App - Monday.com PDF Handler',
        version: '2.0.0',
        endpoints: {
            health: '/health',
            fileHandler: '/file-handler (POST)'
        }
    });
});

app.post('/file-handler', async (req, res) => {
    console.log('✅ Request received from Monday');
    console.log('🧠 Incoming body:', JSON.stringify(req.body, null, 2));

    const input = req.body.payload?.inputFields || {};
    const { itemId, boardId, columnId } = input;

    if (!itemId || !boardId || !columnId) {
        console.log('❌ Missing input fields');
        return res.status(400).json({ error: 'Missing required input fields: itemId, boardId, columnId' });
    }

    if (!MONDAY_API_KEY) {
        console.log('❌ Missing Monday API key');
        return res.status(500).json({ error: 'Monday API key not configured' });
    }

    try {
        const query = `
            query {
                items(ids: ${itemId}) {
                    updates {
                        assets {
                            public_url
                            name
                        }
                    }
                }
            }
        `;

        console.log('📦 Sending GraphQL query...');
        const response = await axios.post(
            'https://api.monday.com/v2',
            { query },
            { 
                headers: { Authorization: MONDAY_API_KEY },
                timeout: 30000 // 30 second timeout
            }
        );

        if (!response.data?.data?.items?.[0]) {
            console.log('❌ No item found with ID:', itemId);
            return res.status(404).json({ error: 'Item not found' });
        }

        const updates = response.data.data.items[0].updates || [];
        const assets = updates.flatMap(u => u.assets || []);
        console.log('📎 Found update files:', assets.map(a => a.name));

        const pdfs = assets.filter(file => 
            file.name && file.name.toLowerCase().endsWith('.pdf') && file.public_url
        );
        
        if (pdfs.length === 0) {
            console.log('⚠️ No PDF files found.');
            return res.json({ message: 'No PDF files found in item updates.' });
        }

        console.log(`🎯 Found ${pdfs.length} PDF file(s) to process`)

        // Process PDFs: first one goes to original item, others create new items
        for (let i = 0; i < pdfs.length; i++) {
            const pdf = pdfs[i];
            const totalPdfs = pdfs.length;
            const suffix = totalPdfs > 1 ? ` [${i + 1}of${totalPdfs}]` : '';
            const modifiedFilename = pdf.name.replace('.pdf', `${suffix}.pdf`);
            
            console.log(`📤 Processing ${i + 1}/${totalPdfs}: ${modifiedFilename}`);

            try {
                let targetItemId = itemId;

                // Create new item for additional PDFs (not the first one)
                if (i > 0) {
                    console.log(`🆕 Creating new item for PDF ${i + 1}`);
                    
                    // Get original item name first
                    const itemQuery = `
                        query {
                            items(ids: ${itemId}) {
                                name
                            }
                        }
                    `;
                    
                    const itemResponse = await axios.post(
                        'https://api.monday.com/v2',
                        { query: itemQuery },
                        { headers: { Authorization: MONDAY_API_KEY } }
                    );
                    
                    const originalName = itemResponse.data?.data?.items?.[0]?.name || 'Item';
                    const newItemName = `${originalName}${suffix}`;
                    
                    // Create new item
                    const createItemMutation = `
                        mutation {
                            create_item (
                                board_id: ${boardId},
                                item_name: "${newItemName}"
                            ) {
                                id
                            }
                        }
                    `;
                    
                    const createResponse = await axios.post(
                        'https://api.monday.com/v2',
                        { query: createItemMutation },
                        { headers: { Authorization: MONDAY_API_KEY } }
                    );
                    
                    targetItemId = createResponse.data?.data?.create_item?.id;
                    console.log(`✅ Created new item: ${newItemName} (ID: ${targetItemId})`);
                    
                    // Add delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                // Download PDF file with retry logic
                let fileResponse;
                let retryCount = 0;
                const maxRetries = 3;
                
                while (retryCount < maxRetries) {
                    try {
                        fileResponse = await axios.get(pdf.public_url, { 
                            responseType: 'stream',
                            timeout: 30000 // 30 second timeout
                        });
                        break;
                    } catch (downloadError) {
                        retryCount++;
                        console.log(`⚠️ Download attempt ${retryCount} failed for ${pdf.name}`);
                        if (retryCount === maxRetries) throw downloadError;
                        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
                    }
                }

                // Upload file with retry logic
                retryCount = 0;
                while (retryCount < maxRetries) {
                    try {
                        const form = new FormData();
                        form.append('query', `
                            mutation ($file: File!) {
                                add_file_to_column (file: $file, item_id: ${targetItemId}, column_id: "${columnId}") {
                                    id
                                }
                            }
                        `);
                        form.append('variables[file]', fileResponse.data, {
                            filename: modifiedFilename,
                            contentType: 'application/pdf'
                        });

                        const uploadResponse = await axios.post('https://api.monday.com/v2/file', form, {
                            headers: {
                                ...form.getHeaders(),
                                Authorization: MONDAY_API_KEY
                            },
                            timeout: 60000 // 60 second timeout for upload
                        });

                        console.log(`✅ Uploaded: ${modifiedFilename} to item ${targetItemId}`);
                        break;
                        
                    } catch (uploadError) {
                        retryCount++;
                        console.log(`⚠️ Upload attempt ${retryCount} failed for ${modifiedFilename}`);
                        if (retryCount === maxRetries) throw uploadError;
                        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds before retry
                    }
                }
                
                // Add delay between files to avoid rate limiting
                if (i < pdfs.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

            } catch (error) {
                console.error(`❌ Error processing ${pdf.name}:`, error.response?.data || error.message);
                // Continue with other files instead of stopping completely
            }
        }

        res.send({ 
            message: `Processed ${pdfs.length} PDF(s). First PDF added to original item, additional PDFs created as new items with suffixes.` 
        });

    } catch (error) {
        console.error('❌ Critical Error:', error.response?.data || error.message);
        console.error('❌ Stack trace:', error.stack);
        res.status(500).json({ 
            error: 'Error processing PDF files',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
    console.log('🔄 SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🔄 SIGINT received, shutting down gracefully');
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Health check available at: http://localhost:${PORT}/health`);
    console.log(`🔧 Monday API Key configured: ${MONDAY_API_KEY ? '✅ Yes' : '❌ No'}`);
});
