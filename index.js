const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const app = express();
app.use(express.json());

require('dotenv').config();
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PORT = process.env.PORT || 3000;

app.post('/file-handler', async (req, res) => {
    console.log('✅ Request received from Monday');
    console.log('🧠 Incoming body:', JSON.stringify(req.body, null, 2));

    const input = req.body.payload?.inputFields || {};
    const { itemId, boardId, columnId } = input;

    if (!itemId || !boardId || !columnId) {
        console.log('❌ Missing input fields');
        return res.status(400).send('Missing required input fields.');
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
            { headers: { Authorization: MONDAY_API_KEY } }
        );

        const updates = response.data?.data?.items?.[0]?.updates || [];
        const assets = updates.flatMap(u => u.assets || []);
        console.log('📎 Found update files:', assets.map(a => a.name));

        const pdfs = assets.filter(file => file.name && file.name.toLowerCase().endsWith('.pdf'));
        if (pdfs.length === 0) {
            console.log('⚠️ No PDF files found.');
            return res.send({ message: 'No PDF files found.' });
        }

        // Process PDFs: create separate items for multiple PDFs with suffixes
        // SIMPLE FIX: Only process 1 file to prevent duplicates
        const maxFiles = 1;
        for (let i = 0; i < Math.min(pdfs.length, maxFiles); i++) {
            const pdf = pdfs[i];
            const totalPdfs = pdfs.length;
            const suffix = totalPdfs > 1 ? ` [${i + 1}of${totalPdfs}]` : '';
            const modifiedFilename = pdf.name.replace('.pdf', `${suffix}.pdf`);
            
            console.log(`📤 Processing PDF ${i + 1}/${totalPdfs}: ${modifiedFilename} (Limited to ${maxFiles} file)`);

            let targetItemId = itemId;

            // Create new item for additional PDFs (not the first one)
            if (i > 0) {
                console.log(`🆕 Creating new item for PDF ${i + 1}`);
                
                // Get original item name
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
                
            } else if (totalPdfs > 1) {
                // Update original item name to include [1of X] suffix
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
                if (!originalName.includes('[1of')) {
                    const newItemName = `${originalName} [1of${totalPdfs}]`;
                    
                    const updateItemMutation = `
                        mutation {
                            change_simple_column_value (
                                board_id: ${boardId},
                                item_id: ${itemId},
                                column_id: "name",
                                value: "${newItemName}"
                            ) {
                                id
                            }
                        }
                    `;
                    
                    await axios.post(
                        'https://api.monday.com/v2',
                        { query: updateItemMutation },
                        { headers: { Authorization: MONDAY_API_KEY } }
                    );
                    
                    console.log(`✅ Updated original item name to: ${newItemName}`);
                }
            }

            // Download and upload PDF
            const fileResponse = await axios.get(pdf.public_url, { responseType: 'stream' });

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

            await axios.post('https://api.monday.com/v2/file', form, {
                headers: {
                    ...form.getHeaders(),
                    Authorization: MONDAY_API_KEY
                }
            });

            console.log(`✅ Uploaded: ${modifiedFilename} to item ${targetItemId}`);
        }

        const processedMessage = pdfs.length === 1 
            ? `Processed 1 PDF file successfully.`
            : `Processed ${pdfs.length} PDF files. Original item updated with [1of${pdfs.length}] suffix, ${pdfs.length - 1} new items created.`;
            
        res.send({ 
            message: processedMessage,
            processedPDFs: pdfs.map(p => p.name),
            totalPDFs: pdfs.length
        });

    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        res.status(500).send('Error processing PDF files');
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
