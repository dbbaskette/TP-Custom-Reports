    // ============================================================================
    // CONSTANTS AND CONFIGURATION
    // ============================================================================
    const CONFIG = {
      MAX_ENTITIES_PER_QUERY: 1000,
      NODE_DRAG_PADDING: 8,
      NODE_BASE_X_OFFSET: 80,
      NODE_X_SPACING: 220,
      NODE_Y_SPACING: 120,
      PREVIEW_MAX_HEIGHT: 420,
      DEBOUNCE_DELAY: 150,
      MAX_INPUT_LENGTH: 500,
      MAX_TITLE_LENGTH: 200,
      MAX_DESCRIPTION_LENGTH: 1000,
      UNDO_MAX_SIZE: 50,
      COLORS: {
        PRIMARY: '#00d9ff',
        SECONDARY: '#b084ff',
        SUCCESS: '#4ade80',
        ERROR: '#f87171',
        WARNING: '#fbbf24'
      }
    };

    // ============================================================================
    // STATE MANAGEMENT
    // ============================================================================
    let schema = null;
    let selectedEntityTypes = [];
    let relationships = [];
    let selectedFields = {}; // { entityType: [fields] }
    let generatedHTML = '';
    let relationshipLayout = {};
    let draggedFieldPayload = null;
    let nodeDragState = null;
    let customQueryOverride = '';
    let cachedOverrideValue = '';
    let cachedOverrideMap = null;
    let previewShell = 'desktop';
    let pointerController = null;
    let updateTimeout = null;

    // Aggregate statistics state - per entity type
    let aggregateStats = {}; // { entityType: [{ id, operation, field, label }] }

    // ============================================================================
    // UTILITY CLASSES
    // ============================================================================

    /**
     * Custom error class for Report Builder
     */
    class ReportBuilderError extends Error {
      constructor(message, code, context = {}) {
        super(message);
        this.name = 'ReportBuilderError';
        this.code = code;
        this.context = context;
      }
    }

    /**
     * DOM element cache for performance
     */
    const DOMCache = {
      _cache: {},

      get(id) {
        if (!this._cache[id]) {
          this._cache[id] = document.getElementById(id);
        }
        return this._cache[id];
      },

      invalidate(id) {
        if (id) {
          delete this._cache[id];
        } else {
          this._cache = {};
        }
      }
    };

    /**
     * Schema cache for performance
     */
    const schemaCache = {
      entityMap: null,
      fieldMap: null,

      buildCache(schema) {
        if (this.entityMap) return; // Already cached

        this.entityMap = new Map();
        this.fieldMap = new Map();

        schema.entityTypes.forEach(et => {
          this.entityMap.set(et.name, et);
          this.fieldMap.set(et.name, getAllFields(et));
        });
      },

      getEntity(name) {
        return this.entityMap?.get(name);
      },

      getFields(name) {
        return this.fieldMap?.get(name) || [];
      },

      clear() {
        this.entityMap = null;
        this.fieldMap = null;
      }
    };

    /**
     * Undo/Redo history manager
     */
    const history = {
      stack: [],
      pointer: -1,
      maxSize: CONFIG.UNDO_MAX_SIZE,

      save() {
        const state = {
          selectedEntityTypes: [...selectedEntityTypes],
          relationships: JSON.parse(JSON.stringify(relationships)),
          selectedFields: JSON.parse(JSON.stringify(selectedFields)),
          relationshipLayout: JSON.parse(JSON.stringify(relationshipLayout))
        };

        // Remove future states if we're in the middle of history
        this.stack = this.stack.slice(0, this.pointer + 1);

        this.stack.push(state);
        if (this.stack.length > this.maxSize) {
          this.stack.shift();
        } else {
          this.pointer++;
        }

        updateUndoRedoButtons();
      },

      undo() {
        if (this.pointer > 0) {
          this.pointer--;
          this.restore(this.stack[this.pointer]);
          updateUndoRedoButtons();
        }
      },

      redo() {
        if (this.pointer < this.stack.length - 1) {
          this.pointer++;
          this.restore(this.stack[this.pointer]);
          updateUndoRedoButtons();
        }
      },

      restore(state) {
        selectedEntityTypes = [...state.selectedEntityTypes];
        relationships = JSON.parse(JSON.stringify(state.relationships));
        selectedFields = JSON.parse(JSON.stringify(state.selectedFields));
        relationshipLayout = JSON.parse(JSON.stringify(state.relationshipLayout));

        displayEntitySelector();
        buildRelationships();
        displayFieldSelector();
      },

      canUndo() {
        return this.pointer > 0;
      },

      canRedo() {
        return this.pointer < this.stack.length - 1;
      },

      clear() {
        this.stack = [];
        this.pointer = -1;
        updateUndoRedoButtons();
      }
    };

    // ============================================================================
    // UTILITY FUNCTIONS
    // ============================================================================

    /**
     * Sanitizes user input to prevent XSS and enforce length limits
     * @param {string} input - The input string to sanitize
     * @param {number} maxLength - Maximum allowed length
     * @returns {string} Sanitized input
     */
    function sanitizeInput(input, maxLength = CONFIG.MAX_INPUT_LENGTH) {
      if (!input || typeof input !== 'string') return '';
      return input.trim().slice(0, maxLength);
    }

    /**
     * Escapes HTML special characters to prevent XSS
     * @param {string} str - String to escape
     * @returns {string} Escaped string
     */
    function escapeHTML(str) {
      if (!str) return '';
      const entities = {
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&#39;'
      };
      return String(str).replace(/[<>&"']/g, c => entities[c]);
    }

    /**
     * Displays an error message to the user
     * @param {Error|ReportBuilderError} error - The error to display
     */
    function showError(error) {
      console.error('Report Builder Error:', error);

      const errorHtml = `
        <div class="error">
          <strong>❌ Error${error.code ? ' ' + error.code : ''}</strong><br>
          ${escapeHTML(error.message)}
          ${error.context ? `<br><small style="color: #9ca3af;">${escapeHTML(JSON.stringify(error.context))}</small>` : ''}
        </div>
      `;

      // Try to find an appropriate container
      const containers = ['schemaStatus', 'entitySelector', 'relationshipBuilder'];
      for (const containerId of containers) {
        const container = DOMCache.get(containerId);
        if (container) {
          container.innerHTML = errorHtml + container.innerHTML;
          break;
        }
      }
    }

    /**
     * Debounces a function call
     * @param {Function} func - Function to debounce
     * @param {number} delay - Delay in milliseconds
     * @returns {Function} Debounced function
     */
    function debounce(func, delay) {
      let timeoutId;
      return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
      };
    }

    /**
     * Updates undo/redo button states
     */
    function updateUndoRedoButtons() {
      const undoBtn = DOMCache.get('undoBtn');
      const redoBtn = DOMCache.get('redoBtn');

      if (undoBtn) undoBtn.disabled = !history.canUndo();
      if (redoBtn) redoBtn.disabled = !history.canRedo();
    }

    /**
     * Validates GraphQL query syntax
     * @param {string} query - The GraphQL query to validate
     * @returns {Object} Validation result with valid flag and errors array
     */
    function validateGraphQLQuery(query) {
      const errors = [];

      if (!query || typeof query !== 'string') {
        errors.push('Query must be a non-empty string');
        return { valid: false, errors };
      }

      // Check for required structure
      if (!query.includes('query') && !query.includes('mutation')) {
        errors.push('Query must contain "query" or "mutation" keyword');
      }

      // Check for balanced braces
      const openBraces = (query.match(/{/g) || []).length;
      const closeBraces = (query.match(/}/g) || []).length;
      if (openBraces !== closeBraces) {
        errors.push('Unbalanced braces in query');
      }

      // Check for balanced parentheses
      const openParens = (query.match(/\(/g) || []).length;
      const closeParens = (query.match(/\)/g) || []).length;
      if (openParens !== closeParens) {
        errors.push('Unbalanced parentheses in query');
      }

      return {
        valid: errors.length === 0,
        errors
      };
    }

    // ============================================================================
    // STEP 1: SCHEMA LOADING
    // ============================================================================

    /**
     * Validates schema structure
     * @param {Object} schema - The schema object to validate
     * @throws {ReportBuilderError} If schema is invalid
     */
    function validateSchema(schema) {
      if (!schema || typeof schema !== 'object') {
        throw new ReportBuilderError('Invalid schema format', 'SCHEMA_INVALID');
      }

      if (!schema.entityTypes || !Array.isArray(schema.entityTypes)) {
        throw new ReportBuilderError('Schema must contain entityTypes array', 'SCHEMA_NO_ENTITIES');
      }

      if (schema.entityTypes.length === 0) {
        throw new ReportBuilderError('No entity types found in schema', 'SCHEMA_EMPTY');
      }

      // Validate each entity type has required fields
      schema.entityTypes.forEach((et, index) => {
        if (!et.name || typeof et.name !== 'string') {
          throw new ReportBuilderError(
            `Entity type at index ${index} missing name`,
            'SCHEMA_ENTITY_INVALID',
            { index }
          );
        }
      });
    }

    /**
     * Loads and processes schema file
     */
    document.getElementById('schemaFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const statusContainer = DOMCache.get('schemaStatus');

      try {
        // Validate file size (max 50MB)
        if (file.size > 50 * 1024 * 1024) {
          throw new ReportBuilderError('Schema file too large (max 50MB)', 'FILE_TOO_LARGE');
        }

        // Validate file type
        if (!file.name.endsWith('.json')) {
          throw new ReportBuilderError('Schema file must be JSON', 'FILE_WRONG_TYPE');
        }

        const text = await file.text();
        schema = JSON.parse(text);

        // Validate schema structure
        validateSchema(schema);

        // Build cache for performance
        schemaCache.buildCache(schema);

        // Clear history when loading new schema
        history.clear();

        statusContainer.innerHTML = `
          <div class="success">
            ✅ Schema loaded successfully!<br>
            Found ${schema.entityTypes.length} entity types
          </div>
        `;

        const step1_5 = DOMCache.get('step1_5');
        if (step1_5) step1_5.style.display = 'block';

        // Default to entity report type
        selectReportType('entity');
      } catch (error) {
        if (error instanceof SyntaxError) {
          showError(new ReportBuilderError('Invalid JSON format', 'JSON_PARSE_ERROR', { error: error.message }));
        } else {
          showError(error);
        }

        statusContainer.innerHTML = `
          <div class="error">❌ ${escapeHTML(error.message)}</div>
        `;
      }
    });

    // Step 2: Display Entity Selector
    function displayEntitySelector() {
      const container = document.getElementById('entitySelector');

      const html = schema.entityTypes.map(et => {
        const isSelected = selectedEntityTypes.includes(et.name);
        return `
          <div class="entity-card ${isSelected ? 'selected' : ''}" onclick="toggleEntityType('${et.name}')">
            <h3>${et.name}</h3>
            <div class="count">${et.totalCount?.toLocaleString() || '?'} entities</div>
            <div class="count" style="margin-top: 4px;">${et.description || ''}</div>
          </div>
        `;
      }).join('');

      container.innerHTML = html;
    }

    /**
     * Toggles entity type selection
     * @param {string} entityTypeName - The entity type name to toggle
     */
    function toggleEntityType(entityTypeName) {
      const index = selectedEntityTypes.indexOf(entityTypeName);

      if (index > -1) {
        selectedEntityTypes.splice(index, 1);
        delete selectedFields[entityTypeName];
        delete relationshipLayout[entityTypeName];
      } else {
        selectedEntityTypes.push(entityTypeName);
        selectedFields[entityTypeName] = [];
        relationshipLayout[entityTypeName] = relationshipLayout[entityTypeName] || {
          x: CONFIG.NODE_BASE_X_OFFSET + (selectedEntityTypes.length * CONFIG.NODE_X_SPACING),
          y: CONFIG.NODE_BASE_X_OFFSET + (selectedEntityTypes.length % 2) * CONFIG.NODE_Y_SPACING
        };
      }

      displayEntitySelector();
      cachedOverrideValue = '';
      cachedOverrideMap = null;

      // Save to history
      history.save();

      // Debounce expensive operations
      clearTimeout(updateTimeout);
      updateTimeout = setTimeout(() => {
        if (selectedEntityTypes.length > 0) {
          const step3 = DOMCache.get('step3');
          const step4 = DOMCache.get('step4');
          if (step3) step3.style.display = 'block';
          if (step4) step4.style.display = 'block';

          buildRelationships();
          displayFieldSelector();
        } else {
          const step3 = DOMCache.get('step3');
          const step4 = DOMCache.get('step4');
          const step5 = DOMCache.get('step5');
          if (step3) step3.style.display = 'none';
          if (step4) step4.style.display = 'none';
          if (step5) step5.style.display = 'none';
        }
      }, CONFIG.DEBOUNCE_DELAY);
    }

    // Step 3: Build Relationships
    function buildRelationships() {
      const container = document.getElementById('relationshipBuilder');
      const canvasSection = document.getElementById('relationshipCanvasSection');
      if (canvasSection) {
        canvasSection.style.display = selectedEntityTypes.length ? 'block' : 'none';
      }

      if (selectedEntityTypes.length < 2) {
        container.innerHTML = `
          <div class="info">
            Select at least 2 entity types to define relationships
          </div>
        `;
        relationships = [];
        renderRelationshipCanvas();
        return;
      }

      // Auto-detect possible relationships based on common fields
      const detectedRelationships = autoDetectRelationships();

      let html = '<h3 style="color: #b084ff; margin-bottom: 16px;">Detected Relationships</h3>';

      if (detectedRelationships.length === 0) {
        html += `<div class="info">No common fields detected. You can still query these entities separately.</div>`;
      } else {
        html += '<div class="relationship-chain">';

        detectedRelationships.forEach((rel, idx) => {
          if (idx > 0) {
            html += '<div class="relationship-arrow">→</div>';
          }
          html += `
            <div class="relationship-entity">
              ${rel.from}
              <div class="relationship-field">${rel.fromField} = ${rel.to}.${rel.toField}</div>
            </div>
          `;
        });

        html += `
          <div class="relationship-entity">
            ${detectedRelationships[detectedRelationships.length - 1].to}
          </div>
        `;
        html += '</div>';
      }

      html += `
        <div style="margin-top: 20px;">
          <h3 style="color: #b084ff; margin-bottom: 12px;">Manual Relationship Definition</h3>
          <div style="background: rgba(0, 0, 0, 0.3); padding: 16px; border-radius: 8px;">
            ${selectedEntityTypes.map((et, idx) => {
              if (idx === selectedEntityTypes.length - 1) return '';
              const fromEntity = schema.entityTypes.find(e => e.name === et);
              const toEntity = schema.entityTypes.find(e => e.name === selectedEntityTypes[idx + 1]);
              const fromFields = getAllFields(fromEntity);
              const toFields = getAllFields(toEntity);

              return `
                <div style="margin-bottom: 20px; padding: 16px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                  <div style="color: #00d9ff; font-weight: 600; margin-bottom: 12px;">
                    Link: ${et} → ${selectedEntityTypes[idx + 1]}
                  </div>

                  <div style="display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center;">
                    <div>
                      <label style="font-size: 12px; color: #9ca3af;">Field in ${et}:</label>
                      <select id="rel_from_${idx}" style="margin-top: 4px;" onchange="updateRelationship(${idx})">
                        <option value="">-- Select Field --</option>
                        ${fromFields.map(field => {
                          const locationLabel = field.location.startsWith('namespace:')
                            ? field.location.split(':')[1]
                            : field.location;
                          return `<option value="${field.name}" data-location="${field.location}">${field.name}${locationLabel && locationLabel !== 'basic' ? ` (${locationLabel})` : ''}</option>`;
                        }).join('')}
                      </select>
                    </div>

                    <div style="color: #b084ff; font-size: 20px; padding-top: 20px;">=</div>

                    <div>
                      <label style="font-size: 12px; color: #9ca3af;">Field in ${selectedEntityTypes[idx + 1]}:</label>
                      <select id="rel_to_${idx}" style="margin-top: 4px;" onchange="updateRelationship(${idx})">
                        <option value="">-- Select Field --</option>
                        ${toFields.map(field => {
                          const locationLabel = field.location.startsWith('namespace:')
                            ? field.location.split(':')[1]
                            : field.location;
                          return `<option value="${field.name}" data-location="${field.location}">${field.name}${locationLabel && locationLabel !== 'basic' ? ` (${locationLabel})` : ''}</option>`;
                        }).join('')}
                      </select>
                    </div>
                  </div>

                  <div style="margin-top: 8px; font-size: 11px; color: #9ca3af;">
                    💡 Example: Space.guid = App.spaceGuid
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;

      container.innerHTML = html;
      relationships = detectedRelationships;
      ensureRelationshipLocations();
      renderRelationshipCanvas();
      updateVisualPreview();
      updateQueryInspector();
    }

    function renderRelationshipCanvas() {
      const canvas = document.getElementById('relationshipCanvas');
      if (!canvas) return;

      if (!selectedEntityTypes.length) {
        canvas.innerHTML = `<div style="padding: 40px; text-align: center; color: #9ca3af;">Select entities to visualize relationships.</div>`;
        return;
      }

      selectedEntityTypes.forEach((entity, idx) => {
        if (!relationshipLayout[entity]) {
          relationshipLayout[entity] = {
            x: 40 + (idx * 220),
            y: 60 + ((idx % 2) * 120)
          };
        }
      });

      const nodesHtml = selectedEntityTypes.map(entity => {
        const pos = relationshipLayout[entity];
        const fieldCount = (selectedFields[entity] || []).length;
        return `
          <div class="relationship-node" data-entity="${entity}" style="left: ${pos.x}px; top: ${pos.y}px;">
            <div class="node-title">${entity}</div>
            <div class="node-fields">${fieldCount} field${fieldCount === 1 ? '' : 's'} selected</div>
          </div>
        `;
      }).join('');

      canvas.innerHTML = `
        <svg class="relationship-svg" id="relationshipSvg"></svg>
        ${nodesHtml}
      `;

      initRelationshipNodeDrag();
      updateRelationshipLines();
    }

    function initRelationshipNodeDrag() {
      const nodes = document.querySelectorAll('.relationship-node');
      nodes.forEach(node => {
        node.addEventListener('pointerdown', onNodePointerDown);
      });
    }

    function onNodePointerDown(event) {
      const node = event.currentTarget;
      const canvas = document.getElementById('relationshipCanvas');
      if (!canvas) return;

      const rect = node.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();

      nodeDragState = {
        entity: node.dataset.entity,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        pointerId: event.pointerId
      };

      node.classList.add('dragging');
      node.setPointerCapture(event.pointerId);
      event.preventDefault();
    }

    function onNodePointerMove(event) {
      if (!nodeDragState) return;
      const canvas = document.getElementById('relationshipCanvas');
      if (!canvas) return;

      const node = canvas.querySelector(`.relationship-node[data-entity="${nodeDragState.entity}"]`);
      if (!node) return;

      const canvasRect = canvas.getBoundingClientRect();
      let newX = event.clientX - canvasRect.left - nodeDragState.offsetX;
      let newY = event.clientY - canvasRect.top - nodeDragState.offsetY;

      newX = Math.max(8, Math.min(newX, canvas.clientWidth - nodeDragState.width - 8));
      newY = Math.max(8, Math.min(newY, canvas.clientHeight - nodeDragState.height - 8));

      node.style.left = `${newX}px`;
      node.style.top = `${newY}px`;

      relationshipLayout[nodeDragState.entity] = { x: newX, y: newY };
      updateRelationshipLines();
    }

    function onNodePointerUp(event) {
      if (!nodeDragState) return;

      const canvas = document.getElementById('relationshipCanvas');
      const node = canvas?.querySelector(`.relationship-node[data-entity="${nodeDragState.entity}"]`);
      node?.classList.remove('dragging');
      node?.releasePointerCapture?.(nodeDragState.pointerId);

      reorderEntitiesByLayout();
      nodeDragState = null;
      buildRelationships();
    }

    function reorderEntitiesByLayout() {
      selectedEntityTypes.sort((a, b) => {
        const posA = relationshipLayout[a]?.x ?? 0;
        const posB = relationshipLayout[b]?.x ?? 0;
        return posA - posB;
      });
    }

    function updateRelationshipLines() {
      const svg = document.getElementById('relationshipSvg');
      const canvas = document.getElementById('relationshipCanvas');
      if (!svg || !canvas) return;

      const canvasRect = canvas.getBoundingClientRect();
      const nodeRects = {};
      canvas.querySelectorAll('.relationship-node').forEach(node => {
        nodeRects[node.dataset.entity] = node.getBoundingClientRect();
      });

      const lines = relationships.map(rel => {
        const fromRect = nodeRects[rel.from];
        const toRect = nodeRects[rel.to];
        if (!fromRect || !toRect) return '';

        const startX = (fromRect.right - canvasRect.left);
        const startY = (fromRect.top - canvasRect.top) + (fromRect.height / 2);
        const endX = (toRect.left - canvasRect.left);
        const endY = (toRect.top - canvasRect.top) + (toRect.height / 2);
        const midX = (startX + endX) / 2;

        return `<path class="relationship-link" d="M${startX},${startY} C ${midX},${startY} ${midX},${endY} ${endX},${endY}"></path>`;
      }).join('');

      svg.setAttribute('width', canvas.clientWidth);
      svg.setAttribute('height', canvas.clientHeight);
      svg.innerHTML = `
        <defs>
          <marker id="arrowHead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L0,6 L9,3 z" fill="#b084ff"></path>
          </marker>
        </defs>
        ${lines}
      `;
    }

    function autoDetectRelationships() {
      const detected = [];

      for (let i = 0; i < selectedEntityTypes.length - 1; i++) {
        const fromType = selectedEntityTypes[i];
        const toType = selectedEntityTypes[i + 1];
        const commonFields = getCommonFields(fromType, toType);

        if (commonFields.length > 0) {
          const preferredFieldMeta = commonFields.find(f =>
            f.name.toLowerCase().includes('id') ||
            f.name.toLowerCase().includes('guid') ||
            f.name.toLowerCase().includes('name')
          ) || commonFields[0];

          detected.push({
            from: fromType,
            to: toType,
            fromField: preferredFieldMeta.name,
            toField: preferredFieldMeta.name,
            fromLocation: preferredFieldMeta.fromLocation || resolveFieldLocation(fromType, preferredFieldMeta.name),
            toLocation: preferredFieldMeta.toLocation || resolveFieldLocation(toType, preferredFieldMeta.name)
          });
        }
      }

      return detected;
    }

    function getAllFields(entity) {
      if (!entity?.fields) return [];

      const fields = [];

      (entity.fields.basic || []).forEach(fieldName => {
        fields.push({ name: fieldName, location: 'basic' });
      });

      (entity.fields.tags || []).forEach(fieldName => {
        fields.push({ name: fieldName, location: 'tag' });
      });

      (entity.fields.properties || []).forEach(fieldName => {
        fields.push({ name: fieldName, location: 'property' });
      });

      if (entity.fields.namespaces) {
        Object.entries(entity.fields.namespaces).forEach(([nsName, props]) => {
          props.forEach(propName => {
            fields.push({ name: propName, location: `namespace:${nsName}` });
          });
        });
      }

      return fields;
    }

    function resolveFieldLocation(entityTypeName, fieldName) {
      const entity = schema?.entityTypes.find(et => et.name === entityTypeName);
      if (!entity?.fields) return 'basic';

      if (entity.fields.basic?.includes(fieldName)) return 'basic';
      if (entity.fields.tags?.includes(fieldName)) return 'tag';
      if (entity.fields.properties?.includes(fieldName)) return 'property';

      if (entity.fields.namespaces) {
        for (const [nsName, props] of Object.entries(entity.fields.namespaces)) {
          if (props.includes(fieldName)) {
            return `namespace:${nsName}`;
          }
        }
      }

      return 'basic';
    }

    function getCommonFields(type1, type2) {
      const entity1 = schema.entityTypes.find(et => et.name === type1);
      const entity2 = schema.entityTypes.find(et => et.name === type2);

      if (!entity1?.fields || !entity2?.fields) return [];

      const fields1 = getAllFields(entity1);
      const fields2 = getAllFields(entity2);
      const map2 = new Map();

      fields2.forEach(field => {
        if (!map2.has(field.name)) {
          map2.set(field.name, field.location);
        }
      });

      const common = [];
      fields1.forEach(field => {
        if (map2.has(field.name)) {
          common.push({
            name: field.name,
            fromLocation: field.location,
            toLocation: map2.get(field.name)
          });
        }
      });

      return common;
    }

    function ensureRelationshipLocations() {
      relationships = relationships.map(rel => {
        if (!rel) return rel;
        return {
          ...rel,
          fromLocation: rel.fromLocation || resolveFieldLocation(rel.from, rel.fromField),
          toLocation: rel.toLocation || resolveFieldLocation(rel.to, rel.toField)
        };
      });
    }

    function updateRelationship(index) {
      const fromSelect = document.getElementById(`rel_from_${index}`);
      const toSelect = document.getElementById(`rel_to_${index}`);
      const fromField = fromSelect?.value;
      const toField = toSelect?.value;
      const fromLocationAttr = fromSelect?.selectedOptions?.[0]?.dataset.location;
      const toLocationAttr = toSelect?.selectedOptions?.[0]?.dataset.location;

      if (fromField && toField) {
        relationships[index] = {
          from: selectedEntityTypes[index],
          to: selectedEntityTypes[index + 1],
          fromField: fromField,
          toField: toField,
          fromLocation: fromLocationAttr || resolveFieldLocation(selectedEntityTypes[index], fromField),
          toLocation: toLocationAttr || resolveFieldLocation(selectedEntityTypes[index + 1], toField)
        };
        console.log('Updated relationship:', relationships[index]);
      }
    }

    // Step 4: Display Field Selector + layout zones
    function displayFieldSelector() {
      const container = document.getElementById('fieldSelector');

      let html = '';

      selectedEntityTypes.forEach(entityTypeName => {
        const entity = schema.entityTypes.find(et => et.name === entityTypeName);
        if (!entity) return;

        html += `
          <div class="field-category">
            <h3>${entityTypeName} Fields</h3>
            <div class="field-grid">
        `;

        if (entity.fields?.basic) {
          entity.fields.basic.forEach(fieldName => {
            const isSelected = selectedFields[entityTypeName]?.some(f =>
              f.name === fieldName && f.location === 'basic'
            );
            const sampleValue = entity.sampleData?.sampleEntities?.[0]?.[fieldName];

            html += `
              <div class="field-item ${isSelected ? 'selected' : ''}"
                   data-entity="${entityTypeName}"
                   data-field="${fieldName}"
                   data-location="basic"
                   onclick="toggleField('${entityTypeName}', '${fieldName}', 'basic')">
                <span class="field-name">${fieldName}</span>
                <span class="field-location">basic field</span>
                ${sampleValue ? `<div class="field-sample">e.g., ${sampleValue}</div>` : ''}
              </div>
            `;
          });
        }

        if (entity.fields?.tags) {
          entity.fields.tags.forEach(tagKey => {
            const isSelected = selectedFields[entityTypeName]?.some(f =>
              f.name === tagKey && f.location === 'tag'
            );
            const sampleValue = getSampleTagValue(entity.sampleData?.sampleEntities?.[0], tagKey);

            html += `
              <div class="field-item ${isSelected ? 'selected' : ''}"
                   data-entity="${entityTypeName}"
                   data-field="${tagKey}"
                   data-location="tag"
                   onclick="toggleField('${entityTypeName}', '${tagKey}', 'tag')">
                <span class="field-name">${tagKey}</span>
                <span class="field-location">tag</span>
                ${sampleValue ? `<div class="field-sample">e.g., ${sampleValue}</div>` : ''}
              </div>
            `;
          });
        }

        if (entity.fields?.properties) {
          entity.fields.properties.forEach(propName => {
            const isSelected = selectedFields[entityTypeName]?.some(f =>
              f.name === propName && f.location === 'property'
            );
            const sampleValue = getSamplePropertyValue(entity.sampleData?.sampleEntities?.[0], propName);

            html += `
              <div class="field-item ${isSelected ? 'selected' : ''}"
                   data-entity="${entityTypeName}"
                   data-field="${propName}"
                   data-location="property"
                   onclick="toggleField('${entityTypeName}', '${propName}', 'property')">
                <span class="field-name">${propName}</span>
                <span class="field-location">property</span>
                ${sampleValue ? `<div class="field-sample">e.g., ${sampleValue}</div>` : ''}
              </div>
            `;
          });
        }

        if (entity.fields?.namespaces) {
          Object.entries(entity.fields.namespaces).forEach(([nsName, props]) => {
            props.forEach(propName => {
              const isSelected = selectedFields[entityTypeName]?.some(f =>
                f.name === propName && f.location === `namespace:${nsName}`
              );
              const sampleValue = getSampleNamespaceValue(entity.sampleData?.sampleEntities?.[0], nsName, propName);

              html += `
                <div class="field-item ${isSelected ? 'selected' : ''}"
                     data-entity="${entityTypeName}"
                     data-field="${propName}"
                     data-location="namespace:${nsName}"
                     onclick="toggleField('${entityTypeName}', '${propName}', 'namespace:${nsName}')">
                  <span class="field-name">${propName}</span>
                  <span class="field-location">${nsName}</span>
                  ${sampleValue ? `<div class="field-sample">e.g., ${sampleValue}</div>` : ''}
                </div>
              `;
            });
          });
        }

        html += `
            </div>
            ${renderAggregateSection(entityTypeName)}
            ${renderLayoutZones(entityTypeName)}
          </div>
        `;
      });

      container.innerHTML = html;
      initFieldDragAndDrop();
      initChipLabelToggles();

      const hasSelectedFields = Object.values(selectedFields).some(fields => fields.length > 0);
      if (hasSelectedFields) {
        document.getElementById('step5').style.display = 'block';
        populateDisplayModeOptions();
        document.getElementById('queryInspector').style.display = 'block';
        document.getElementById('visualPreview').style.display = 'block';
        updateVisualPreview();
        updateQueryInspector();
      } else {
        document.getElementById('step5').style.display = 'none';
        document.getElementById('visualPreview').style.display = 'none';
        document.getElementById('queryInspector').style.display = 'none';
      }
    }

    function renderAggregateSection(entityType) {
      const safeId = entityType.replace(/\./g, '_');
      return `
        <div style="margin-top: 20px; padding: 16px; background: rgba(176, 132, 255, 0.1); border: 1px solid rgba(176, 132, 255, 0.3); border-radius: 8px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
            <h4 style="margin: 0; color: #b084ff; font-size: 14px;">📊 Aggregate Statistics</h4>
            <button type="button" class="btn btn-secondary" style="font-size: 11px; padding: 4px 10px;" onclick="addAggregateStat('${entityType}')">+ Add Stat</button>
          </div>
          <div style="font-size: 12px; color: #9ca3af; margin-bottom: 12px;">
            Add summary statistic cards that appear below the header in the report
          </div>
          <div id="aggregateStats_${safeId}">
            <div style="text-align: center; color: #9ca3af; padding: 12px; font-size: 13px;">No aggregate statistics. Click "+ Add Stat" to create one.</div>
          </div>
        </div>
      `;
    }

    function renderLayoutZones(entityType) {
      const zoneOrder = [
        { id: 'header', label: 'Header' },
        { id: 'summary', label: 'Summary Row' },
        { id: 'detail', label: 'Per-Entity Detail' }
      ];

      return `
        <div class="layout-dropzones">
          <h4>Layout Zones</h4>
          <div class="layout-zones">
            ${zoneOrder.map(zone => {
              const fields = getFieldsForZone(entityType, zone.id);
              const chips = fields.length
                ? fields.map(field => {
                    const labelClass = field.showLabel === false ? 'chip-label-toggle value-only' : 'chip-label-toggle';
                    const labelText = field.showLabel === false ? 'Value only' : 'Label + value';
                    return `
                      <div class="layout-chip"
                           data-chip-entity="${entityType}"
                           data-chip-field="${field.name}"
                           data-chip-location="${field.location}"
                           onclick="cycleChipZone('${entityType}', '${field.name}', '${field.location}')">
                        <div class="chip-primary">
                          <strong>${field.name}</strong>
                          <span>${field.location}</span>
                        </div>
                        <div class="chip-actions">
                          <button type="button"
                                  class="${labelClass}"
                                  data-entity="${entityType}"
                                  data-field="${field.name}"
                                  data-location="${field.location}">
                            ${labelText}
                          </button>
                        </div>
                      </div>
                    `;
                  }).join('')
                : '<div style="font-size: 11px; color: #4b5563;">Drop fields here</div>';

              return `
                <div class="layout-zone"
                     data-entity="${entityType}"
                     data-zone="${zone.id}">
                  <div class="zone-title">${zone.label}</div>
                  <div class="zone-body">${chips}</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    function initFieldDragAndDrop() {
      document.querySelectorAll('.field-item').forEach(item => {
        item.setAttribute('draggable', 'true');
        item.addEventListener('dragstart', handleFieldDragStart);
        item.addEventListener('dragend', handleFieldDragEnd);
      });

      document.querySelectorAll('.layout-zone').forEach(zone => {
        zone.addEventListener('dragover', handleLayoutDragOver);
        zone.addEventListener('dragleave', handleLayoutDragLeave);
        zone.addEventListener('drop', handleLayoutDrop);
      });
    }

    function initChipLabelToggles() {
      document.querySelectorAll('.chip-label-toggle').forEach(btn => {
        btn.addEventListener('click', event => {
          event.stopPropagation();
          toggleFieldLabel(
            btn.dataset.entity,
            btn.dataset.field,
            btn.dataset.location
          );
        });
      });
    }

    function handleFieldDragStart(event) {
      const target = event.currentTarget;
      draggedFieldPayload = {
        entityType: target.dataset.entity,
        fieldName: target.dataset.field,
        location: target.dataset.location
      };
      if (event.dataTransfer) {
        event.dataTransfer.setData('text/plain', JSON.stringify(draggedFieldPayload));
        event.dataTransfer.effectAllowed = 'move';
      }
    }

    function handleFieldDragEnd() {
      draggedFieldPayload = null;
    }

    function handleLayoutDragOver(event) {
      event.preventDefault();
      event.currentTarget.classList.add('drag-over');
    }

    function handleLayoutDragLeave(event) {
      event.currentTarget.classList.remove('drag-over');
    }

    function handleLayoutDrop(event) {
      event.preventDefault();
      event.currentTarget.classList.remove('drag-over');
      const entityType = event.currentTarget.dataset.entity;
      const zone = event.currentTarget.dataset.zone;
      let payload = draggedFieldPayload;

      if (!payload && event.dataTransfer?.getData('text/plain')) {
        try {
          payload = JSON.parse(event.dataTransfer.getData('text/plain'));
        } catch (_) {
          payload = null;
        }
      }

      if (!payload || payload.entityType !== entityType) return;
      assignFieldToZone(entityType, payload.fieldName, payload.location, zone);
    }

    function assignFieldToZone(entityType, fieldName, location, zone) {
      if (!selectedFields[entityType]) {
        selectedFields[entityType] = [];
      }

      let field = selectedFields[entityType].find(f =>
        f.name === fieldName && f.location === location
      );

      if (!field) {
        field = { name: fieldName, location, zone: zone || 'detail', showLabel: true };
        selectedFields[entityType].push(field);
      } else {
        field.zone = zone;
      }

      draggedFieldPayload = null;
      displayFieldSelector();
    }

    function getFieldsForZone(entityType, zone) {
      return (selectedFields[entityType] || []).filter(f => (f.zone || 'detail') === zone);
    }

    function cycleChipZone(entityType, fieldName, location) {
      const zoneOrder = ['header', 'summary', 'detail'];
      const field = (selectedFields[entityType] || []).find(f =>
        f.name === fieldName && f.location === location
      );
      if (!field) return;

      const currentIndex = zoneOrder.indexOf(field.zone || 'detail');
      field.zone = zoneOrder[(currentIndex + 1) % zoneOrder.length];
      displayFieldSelector();
    }

    function toggleFieldLabel(entityType, fieldName, location) {
      const fields = selectedFields[entityType];
      if (!fields) return;
      const field = fields.find(f => f.name === fieldName && f.location === location);
      if (!field) return;
      field.showLabel = field.showLabel === false ? true : false;
      displayFieldSelector();
    }

    function getFieldsNeededForEntity(entityType) {
      const selected = selectedFields[entityType] ? [...selectedFields[entityType]] : [];
      const required = [...selected];

      relationships.forEach(rel => {
        if (rel?.from === entityType && rel.fromField) {
          const entry = {
            name: rel.fromField,
            location: rel.fromLocation || resolveFieldLocation(entityType, rel.fromField),
            showLabel: true
          };
          if (!required.some(f => f.name === entry.name && f.location === entry.location)) {
            required.push(entry);
          }
        }
        if (rel?.to === entityType && rel.toField) {
          const entry = {
            name: rel.toField,
            location: rel.toLocation || resolveFieldLocation(entityType, rel.toField),
            showLabel: true
          };
          if (!required.some(f => f.name === entry.name && f.location === entry.location)) {
            required.push(entry);
          }
        }
      });

      return required;
    }

    function updateVisualPreview() {
      const previewWrapper = document.getElementById('visualPreview');
      const previewFrame = document.getElementById('previewFrame');
      if (!previewWrapper || !previewFrame) return;

      const hasFields = Object.values(selectedFields).some(fields => fields.length > 0);
      previewWrapper.style.display = hasFields ? 'block' : 'none';
      if (!hasFields) {
        previewFrame.innerHTML = '';
        return;
      }

      previewFrame.className = `device-frame ${previewShell}`;
      previewFrame.innerHTML = renderPreviewTemplate();
    }

    function renderPreviewTemplate() {
      if (!selectedEntityTypes.length) {
        return '<p style="color: #9ca3af;">Select entity types to preview the layout.</p>';
      }

      const displayMode = document.getElementById('displayMode')?.value || 'hierarchical';

      if (selectedEntityTypes.length === 1) {
        return renderSingleEntityPreview(selectedEntityTypes[0], displayMode);
      }

      const tree = buildMockHierarchyTree();
      return renderMultiEntityPreview(tree, displayMode);
    }

    function renderSingleEntityPreview(entityType, displayMode) {
      const fields = selectedFields[entityType] || [];
      if (!fields.length) {
        return `<p style="color: #9ca3af;">Select at least one field for ${entityType}.</p>`;
      }

      const previewRows = [buildMockEntityRow(entityType, fields), buildMockEntityRow(entityType, fields, 1)];

      if (displayMode === 'grouped') {
        return `
          <div class="group-header">Grouped by ${fields[0].name}</div>
          ${previewRows.map((row, idx) => `
            <div class="entity-item">
              <strong>${row[fields[0].name] || `Group ${idx + 1}`}</strong>
              <div style="font-size: 12px; color: #9ca3af;">
                ${fields.slice(1).map(f => `${f.name}: ${row[f.name] || '-'}`).join(' • ')}
              </div>
            </div>
          `).join('')}
        `;
      }

      let summary = '';
      if (displayMode === 'summary-table') {
        summary = `
          <div class="summary-card" style="margin-bottom: 16px;">
            <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em;">Summary</div>
            <div style="font-size: 28px; font-weight: 600;">${previewRows.length} ${entityType}</div>
          </div>
        `;
      }

      const headers = fields.map(f => `<th>${f.name}</th>`).join('');
      const rows = previewRows.map(row => `
        <tr>${fields.map(f => `<td>${row[f.name] || '-'}</td>`).join('')}</tr>
      `).join('');

      return `
        ${summary}
        <table>
          <thead><tr>${headers}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }

    function renderMultiEntityPreview(tree, displayMode) {
      if (displayMode === 'table') {
        const rows = flattenHierarchy(tree);
        return `
          <table>
            <thead>
              <tr>
                <th>Entity</th>
                <th>Path</th>
                <th>Highlights</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(row => `
                <tr>
                  <td style="padding-left: ${row.depth * 16}px;">${row.entityType}</td>
                  <td>${row.path.join(' → ')}</td>
                  <td>${row.summary}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }

      if (displayMode === 'cards') {
        return `
          ${renderCardPreview(tree)}
        `;
      }

      if (displayMode === 'timeline') {
        const steps = flattenHierarchy(tree);
        return `
          <div class="timeline">
            ${steps.map(step => `
              <div class="timeline-step">
                <div style="font-weight: 600; color: #00d9ff;">${step.entityType}</div>
                <div style="font-size: 12px; color: #9ca3af;">${step.path.join(' › ')}</div>
                <div style="font-size: 12px;">${step.summary}</div>
              </div>
            `).join('')}
          </div>
        `;
      }

      return renderHierarchyPreview(tree);
    }

    function renderHierarchyPreview(node, depth = 0) {
      const fields = selectedFields[node.entityType] || [];
      const sampleRow = buildMockEntityRow(node.entityType, fields);
      const details = renderFieldPreviewList(node.entityType, sampleRow);
      return `
        <div class="hierarchy-level" style="margin-left: ${depth === 0 ? 0 : 20}px;">
          <div class="entity-item">
            <strong style="color: #00d9ff; display: block; margin-bottom: 6px;">${node.entityType}</strong>
            ${details}
          </div>
          ${node.children?.map(child => renderHierarchyPreview(child, depth + 1)).join('') || ''}
        </div>
      `;
    }

    function renderCardPreview(node) {
      const fields = selectedFields[node.entityType] || [];
      const sampleRow = buildMockEntityRow(node.entityType, fields);
      const details = renderFieldPreviewList(node.entityType, sampleRow);
      return `
        <div class="preview-card">
          <h4>${node.entityType}</h4>
          <div style="font-size: 12px;">
            ${details}
          </div>
          ${node.children?.length ? `
            <div style="margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px;">
              ${node.children.map(child => renderCardPreview(child)).join('')}
            </div>` : ''}
        </div>
      `;
    }

    function buildMockHierarchyTree() {
      const buildLevel = (depth, prefix = 'Sample') => {
        const entityType = selectedEntityTypes[depth];
        const label = `${prefix} ${entityType}`;
        const node = {
          entityType,
          label,
          children: []
        };

        if (depth < selectedEntityTypes.length - 1) {
          node.children.push(buildLevel(depth + 1, 'Child'));
          node.children.push(buildLevel(depth + 1, 'Alt'));
        }

        return node;
      };

      return buildLevel(0);
    }

    function summarizeFields(entityType) {
      const fields = selectedFields[entityType] || [];
      return fields.slice(0, 3).map(f => f.name).join(' • ') || 'No fields selected';
    }

    function flattenHierarchy(node, path = [], depth = 0, rows = []) {
      const currentPath = [...path, node.entityType];
      rows.push({
        entityType: node.entityType,
        path: currentPath,
        depth,
        summary: summarizeFields(node.entityType)
      });

      node.children?.forEach(child => flattenHierarchy(child, currentPath, depth + 1, rows));
      return rows;
    }

    function buildMockEntityRow(entityType, fields, offset = 0) {
      const row = {};
      fields.forEach((field, idx) => {
        row[field.name] = `${field.name} ${idx + 1 + offset}`;
      });
      return row;
    }

    function renderFieldPreviewList(entityType, sampleRow) {
      const fields = selectedFields[entityType] || [];
      if (!fields.length) {
        return '<div style="font-size: 11px; color: #4b5563;">No fields selected</div>';
      }
      return fields.map(field => {
        const value = sampleRow?.[field.name] || `${field.name} value`;
        if (field.showLabel === false) {
          return `<div>${value}</div>`;
        }
        return `<div><strong>${field.name}:</strong> ${value}</div>`;
      }).join('');
    }

    function updateQueryInspector() {
      const inspector = document.getElementById('queryInspector');
      const textarea = document.getElementById('queryInspectorText');
      const status = document.getElementById('queryInspectorStatus');
      if (!inspector || !textarea) return;

      const hasFields = Object.values(selectedFields).some(fields => fields.length > 0);
      inspector.style.display = hasFields ? 'block' : 'none';
      if (!hasFields) {
        textarea.value = '';
        if (status) status.textContent = '';
        return;
      }

      const autoQuery = generateGraphQLQueryText();
      textarea.dataset.autoQuery = autoQuery;
      textarea.value = customQueryOverride || autoQuery;
    }

    function generateGraphQLQueryText() {
      if (!selectedEntityTypes.length) return '';

      if (selectedEntityTypes.length === 1) {
        const entityType = selectedEntityTypes[0];
        const selection = buildFieldSelectionSet(entityType);
        return `query Get${entityType.replace(/\\W/g, '_')}(\\$first: Int!, \\$entityType: [String!]) {
  entityQuery {
    queryEntities(first: \\$first, entityType: \\$entityType) {
      totalCount
      entities {
${selection}
      }
    }
  }
}`;
      }

      return selectedEntityTypes.map(entityType => {
        const selection = buildFieldSelectionSet(entityType);
        return `# ${entityType}
query Get${entityType.replace(/\\W/g, '_')}(\\$first: Int!, \\$entityType: [String!]) {
  entityQuery {
    queryEntities(first: \\$first, entityType: \\$entityType) {
      totalCount
      entities {
${selection}
      }
    }
  }
}`;
      }).join('\\n\\n');
    }

    /**
     * Builds GraphQL field selection set for an entity type
     * @param {string} entityType - The entity type name
     * @returns {string} GraphQL field selection
     */
    function buildFieldSelectionSet(entityType) {
      const fields = getFieldsNeededForEntity(entityType);
      const lines = [];
      const basic = fields.filter(f => f.location === 'basic');

      if (basic.length) {
        basic.forEach(field => lines.push(`        ${field.name}`));
      } else {
        // Find available basic fields from schema
        const entity = schemaCache.getEntity(entityType) || schema.entityTypes.find(e => e.name === entityType);
        const availableBasic = entity?.fields?.basic || [];

        if (availableBasic.includes('entityId')) lines.push('        entityId');
        if (availableBasic.includes('entityName')) lines.push('        entityName');

        // Fallback: use first available basic field
        if (lines.length === 0 && availableBasic.length > 0) {
          lines.push(`        ${availableBasic[0]}`);
        }

        // Last resort: if still no fields, throw error
        if (lines.length === 0) {
          throw new ReportBuilderError(
            `No fields available for entity type: ${entityType}`,
            'NO_FIELDS_AVAILABLE',
            { entityType }
          );
        }
      }

      if (fields.some(f => f.location === 'tag')) {
        lines.push('        tags { key value }');
      }

      if (fields.some(f => f.location === 'property')) {
        lines.push('        properties { name value }');
      }

      const namespaces = [...new Set(
        fields.filter(f => f.location.startsWith('namespace:')).map(f => f.location.split(':')[1])
      )];

      if (namespaces.length) {
        lines.push('        namespaces {');
        lines.push('          name');
        lines.push('          properties { name value }');
        lines.push('        }');
      }

      return lines.join('\\n');
    }

    function getParsedOverrideMap() {
      if (!customQueryOverride?.trim()) {
        cachedOverrideValue = '';
        cachedOverrideMap = null;
        return null;
      }

      if (cachedOverrideValue === customQueryOverride) {
        return cachedOverrideMap;
      }

      cachedOverrideValue = customQueryOverride;
      cachedOverrideMap = parseOverrideString(customQueryOverride);
      return cachedOverrideMap;
    }

    function parseOverrideString(text) {
      const trimmed = text.trim();
      if (!trimmed) return null;

      if (selectedEntityTypes.length === 1) {
        return { [selectedEntityTypes[0]]: trimmed };
      }

      const sections = {};
      let current = null;
      let buffer = [];
      trimmed.split(/\r?\n/).forEach(line => {
        const header = line.match(/^#\s*(.+)$/);
        if (header) {
          if (current && buffer.length) {
            sections[current] = buffer.join('\n').trim();
          }
          current = header[1].trim();
          buffer = [];
        } else {
          buffer.push(line);
        }
      });

      if (current && buffer.length) {
        sections[current] = buffer.join('\n').trim();
      }

      if (!Object.keys(sections).length) {
        return { __default: trimmed };
      }

      return sections;
    }

    function getQueryOverrideForEntity(entityType) {
      const map = getParsedOverrideMap();
      if (!map) return null;
      return map[entityType] || map.__default || null;
    }

    function setQueryInspectorStatus(message) {
      const status = document.getElementById('queryInspectorStatus');
      if (status) {
        status.textContent = message || '';
      }
    }

    function populateDisplayModeOptions() {
      const displayModeSelect = document.getElementById('displayMode');
      const displayModeHelp = document.getElementById('displayModeHelp');
      const isSingleEntity = selectedEntityTypes.length === 1;
      const previousValue = displayModeSelect.value;

      if (isSingleEntity) {
        displayModeSelect.innerHTML = `
          <option value="table">Simple Table</option>
          <option value="summary-table">Summary + Table</option>
          <option value="grouped">Grouped by Field</option>
        `;
        displayModeHelp.textContent = '💡 Single entity selected - choose a display template';
      } else {
        displayModeSelect.innerHTML = `
          <option value="hierarchical">Hierarchical Tree</option>
          <option value="table">Indented List</option>
          <option value="cards">Stacked Cards</option>
          <option value="timeline">Journey Timeline</option>
        `;
        displayModeHelp.textContent = `💡 ${selectedEntityTypes.length} entities selected - experiment with different layouts`;
      }

      if ([...displayModeSelect.options].some(opt => opt.value === previousValue)) {
        displayModeSelect.value = previousValue;
      }

      updateVisualPreview();
    }

    function toggleField(entityType, fieldName, location) {
      if (!selectedFields[entityType]) {
        selectedFields[entityType] = [];
      }

      const index = selectedFields[entityType].findIndex(f =>
        f.name === fieldName && f.location === location
      );

      if (index > -1) {
        selectedFields[entityType].splice(index, 1);
      } else {
        selectedFields[entityType].push({ name: fieldName, location: location, zone: 'detail', showLabel: true });
      }

      displayFieldSelector();
    }

    function getSampleTagValue(entity, tagKey) {
      if (!entity?.tags) return null;
      const tag = entity.tags.find(t => t.key === tagKey);
      return tag?.value;
    }

    function getSamplePropertyValue(entity, propName) {
      if (!entity?.properties) return null;
      const prop = entity.properties.find(p => p.name === propName);
      return prop?.value;
    }

    function getSampleNamespaceValue(entity, nsName, propName) {
      if (!entity?.namespaces) return null;
      const ns = entity.namespaces.find(n => n.name === nsName);
      if (!ns?.properties) return null;
      const prop = ns.properties.find(p => p.name === propName);
      return prop?.value;
    }

    document.getElementById('displayMode')?.addEventListener('change', () => {
      updateVisualPreview();
    });

    document.getElementById('previewShellSelect')?.addEventListener('change', (event) => {
      previewShell = event.target.value;
      updateVisualPreview();
    });

    document.getElementById('applyQueryOverride')?.addEventListener('click', () => {
      const textarea = document.getElementById('queryInspectorText');
      if (!textarea) return;
      customQueryOverride = textarea.value.trim();
      cachedOverrideValue = '';
      cachedOverrideMap = null;
      setQueryInspectorStatus(customQueryOverride ? 'Custom override applied. It will be used for matching entity fetches.' : 'Override cleared. Using auto-generated query.');
    });

    document.getElementById('resetQueryOverride')?.addEventListener('click', () => {
      customQueryOverride = '';
      cachedOverrideValue = '';
      cachedOverrideMap = null;
      updateQueryInspector();
      setQueryInspectorStatus('Reverted to auto-generated query.');
    });

    document.getElementById('copyQueryBtn')?.addEventListener('click', async () => {
      const textarea = document.getElementById('queryInspectorText');
      if (!textarea) return;
      try {
        await navigator.clipboard.writeText(textarea.value);
        alert('GraphQL query copied to clipboard.');
      } catch (_) {
        alert('Unable to copy automatically. Select the query text and copy manually.');
      }
    });

    /**
     * Initialize global pointer events with cleanup
     */
    function initGlobalPointerEvents() {
      // Remove old listeners if they exist
      if (pointerController) {
        pointerController.abort();
      }

      // Create new controller
      pointerController = new AbortController();
      const signal = { signal: pointerController.signal };

      document.addEventListener('pointermove', onNodePointerMove, signal);
      document.addEventListener('pointerup', onNodePointerUp, signal);
      window.addEventListener('resize', () => updateRelationshipLines(), signal);
    }

    // Initialize pointer events
    initGlobalPointerEvents();

    // ============================================================================
    // STEP 5: GENERATE REPORT
    // ============================================================================

    /**
     * Generates report with validation
     */
    document.getElementById('generateBtn')?.addEventListener('click', () => {
      try {
        const title = sanitizeInput(
          DOMCache.get('reportTitle')?.value || 'Multi-Entity Report',
          CONFIG.MAX_TITLE_LENGTH
        );
        const description = sanitizeInput(
          DOMCache.get('reportDescription')?.value || '',
          CONFIG.MAX_DESCRIPTION_LENGTH
        );
        const displayMode = DOMCache.get('displayMode')?.value;

        // Validate we have something to report on
        if (selectedEntityTypes.length === 0) {
          throw new ReportBuilderError('Please select at least one entity type', 'NO_ENTITIES_SELECTED');
        }

        const hasFields = Object.values(selectedFields).some(fields => fields.length > 0);
        if (!hasFields) {
          throw new ReportBuilderError('Please select at least one field to display', 'NO_FIELDS_SELECTED');
        }

        generatedHTML = generateMultiEntityReport(title, description, displayMode);

        const step6 = DOMCache.get('step6');
        if (step6) {
          step6.style.display = 'block';
          step6.scrollIntoView({ behavior: 'smooth' });
        }
      } catch (error) {
        showError(error);
      }
    });

    document.getElementById('previewBtn')?.addEventListener('click', () => {
      const preview = document.getElementById('reportPreview');
      preview.innerHTML = `
        <div class="report-preview">
          <h3 style="color: #00d9ff; margin-top: 0;">Report Structure Preview</h3>
          <pre>${generateStructurePreview()}</pre>
        </div>
      `;
    });

    function generateStructurePreview() {
      let preview = 'Report Structure:\n\n';

      selectedEntityTypes.forEach((entityType, idx) => {
        const indent = '  '.repeat(idx);
        const fields = selectedFields[entityType] || [];

        preview += `${indent}${entityType} (${fields.length} fields)\n`;
        fields.forEach(field => {
          preview += `${indent}  - ${field.name} (${field.location})\n`;
        });

        if (relationships[idx]) {
          preview += `${indent}  └─ linked to ${relationships[idx].to} via ${relationships[idx].fromField} = ${relationships[idx].to}.${relationships[idx].toField}\n`;
        }
        preview += '\n';
      });

      return preview;
    }

    // Single Entity Report Generation (with templates)
    function generateSingleEntityReport(title, description, displayMode) {
      const entityType = selectedEntityTypes[0];
      const fields = selectedFields[entityType] || [];

      const displayFunction = generateSingleEntityDisplayFunction(displayMode, entityType, fields);
      const helperFunctions = generateHelperFunctions();
      const overrideQuery = getQueryOverrideForEntity(entityType);
      const defaultQueryBody = `
        query GetEntities(\\$first: Int!, \\$entityType: [String!]) {
          entityQuery {
            queryEntities(first: \\$first, entityType: \\$entityType) {
              totalCount
              entities {
                ${fields.filter(f => f.location === 'basic').map(f => f.name).join('\\n                ')}${fields.some(f => f.location === 'tag') ? '\\n                tags { key value }' : ''}${fields.some(f => f.location === 'property') ? '\\n                properties { name value }' : ''}${fields.some(f => f.location.startsWith('namespace:')) ? '\\n                namespaces { name properties { name value } }' : ''}
              }
            }
          }
        }
      `;
      const queryDeclaration = overrideQuery
        ? `const query = ${JSON.stringify(overrideQuery)};`
        : `const query = \`${defaultQueryBody}\`;`;

      // Escape special characters for safe embedding in HTML
      const escapedTitle = escapeHTML(sanitizeInput(title, CONFIG.MAX_TITLE_LENGTH));
      const escapedDesc = description ? escapeHTML(sanitizeInput(description, CONFIG.MAX_DESCRIPTION_LENGTH)) : '';

      // Generate aggregate components
      const aggregateQueries = generateAggregateQueries();
      const aggregateRenderer = generateAggregateRenderer();
      const aggregateCSS = generateAggregateCSS();

      return `<!DOCTYPE html>
<html>
<head>
  <title>${escapedTitle}</title>
  <style>
    body { margin: 0; padding: 0; background: #000; font-family: 'Inter', sans-serif; color: #e0e0e0; }
    .header { background: #0f171c; padding: 20px; border-bottom: 2px solid #00d9ff; }
    .container { padding: 40px; max-width: 1400px; margin: 0 auto; }
    #loading { background: #ffe9a2; color: #000; padding: 16px; text-align: center; }
    table { width: 100%; border-collapse: collapse; background: rgba(255,255,255,0.05); border-radius: 8px; overflow: hidden; }
    th { padding: 12px; text-align: left; background: rgba(0,217,255,0.1); color: #00d9ff; border-bottom: 2px solid rgba(255,255,255,0.1); }
    td { padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    tr:hover { background: rgba(255,255,255,0.02); }
    .summary-card { background: rgba(0,217,255,0.1); padding: 20px; border-radius: 8px; border-left: 4px solid #00d9ff; }
    .group-header { color: #00d9ff; padding: 12px; background: rgba(0,217,255,0.1); border-radius: 6px; margin-bottom: 12px; }
    ${aggregateCSS}
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapedTitle}</h1>
    ${escapedDesc ? `<p style="color: #9ca3af; margin-top: 8px;">${escapedDesc}</p>` : ''}
  </div>
  <div id="loading">⏳ Loading data...</div>
  ${aggregateStats.length > 0 ? '<div class="container"><div id="aggregate-stats"></div></div>' : ''}
  <div class="container">
    <div id="report-content"></div>
  </div>

  <script>
    var serviceUrl = '';
    var bearerToken = '';

    ${helperFunctions}

    ${aggregateQueries}

    ${aggregateRenderer}

    async function fetchData() {
      ${queryDeclaration}

      const variables = {
        first: 1000,
        entityType: ["${entityType}"]
      };

      try {
        const response = await fetch(serviceUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': bearerToken
          },
          body: JSON.stringify({ query, variables })
        });

        const result = await response.json();
        if (result.errors) {
          document.getElementById('loading').innerHTML = '❌ Error: ' + JSON.stringify(result.errors);
          return;
        }

        const data = result.data.entityQuery.queryEntities;
        document.getElementById('loading').style.display = 'none';
        displayData(data);
      } catch (error) {
        document.getElementById('loading').innerHTML = '❌ Error: ' + error.message;
      }
    }

    ${displayFunction}

    async function main() {
      ${aggregateStats.length > 0 ? 'await fetchAllAggregates();' : ''}
      await fetchData();
    }

    function receiveHubToken(event) {
      const config = event?.data?.data;
      if (event?.data?.type === 'apiConfig' && config?.token?.length && config?.endPoint?.length) {
        bearerToken = config?.token;
        serviceUrl = config?.endPoint;
        main();
      }
    }

    window.addEventListener('message', receiveHubToken, false);
  <\/script>
</body>
</html>`;
    }

    function generateSingleEntityDisplayFunction(displayMode, entityType, fields) {
      if (displayMode === 'summary-table') {
        return generateSummaryTableDisplay(fields);
      } else if (displayMode === 'grouped') {
        return generateGroupedDisplay(fields);
      } else {
        return generateTableDisplay(fields);
      }
    }

    function generateTableDisplay(fields) {
      return `
    function displayData(data) {
      const entities = data.entities || [];
      let html = '<table><thead><tr>';
      ${fields.map(f => `html += '<th>${f.name}</th>';`).join('\\n      ')}
      html += '</tr></thead><tbody>';

      entities.forEach(entity => {
        html += '<tr>';
        ${fields.map(f => {
          if (f.location === 'basic') return `html += '<td>' + (entity.${f.name} || '-') + '</td>';`;
          if (f.location === 'tag') return `html += '<td>' + (getTagValue(entity.tags, '${f.name}') || '-') + '</td>';`;
          if (f.location === 'property') return `html += '<td>' + (getPropertyValue(entity.properties, '${f.name}') || '-') + '</td>';`;
          return `html += '<td>-</td>';`;
        }).join('\\n        ')}
        html += '</tr>';
      });

      html += '</tbody></table>';
      document.getElementById('report-content').innerHTML = html;
    }`;
    }

    function generateSummaryTableDisplay(fields) {
      return `
    function displayData(data) {
      const entities = data.entities || [];
      let html = '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px;">';
      html += '<div class="summary-card"><h3 style="margin: 0;">Total Entities</h3><div style="font-size: 32px; font-weight: bold; margin-top: 8px;">' + entities.length + '</div></div>';
      html += '</div>';

      html += '<table><thead><tr>';
      ${fields.map(f => `html += '<th>${f.name}</th>';`).join('\\n      ')}
      html += '</tr></thead><tbody>';

      entities.forEach(entity => {
        html += '<tr>';
        ${fields.map(f => {
          if (f.location === 'basic') return `html += '<td>' + (entity.${f.name} || '-') + '</td>';`;
          if (f.location === 'tag') return `html += '<td>' + (getTagValue(entity.tags, '${f.name}') || '-') + '</td>';`;
          if (f.location === 'property') return `html += '<td>' + (getPropertyValue(entity.properties, '${f.name}') || '-') + '</td>';`;
          return `html += '<td>-</td>';`;
        }).join('\\n        ')}
        html += '</tr>';
      });

      html += '</tbody></table>';
      document.getElementById('report-content').innerHTML = html;
    }`;
    }

    function generateGroupedDisplay(fields) {
      const groupField = fields[0];
      let groupAccessor = '';
      if (groupField.location === 'basic') groupAccessor = `entity.${groupField.name}`;
      else if (groupField.location === 'tag') groupAccessor = `getTagValue(entity.tags, '${groupField.name}')`;
      else if (groupField.location === 'property') groupAccessor = `getPropertyValue(entity.properties, '${groupField.name}')`;
      else groupAccessor = `'Unknown'`;

      return `
    function displayData(data) {
      const entities = data.entities || [];
      const groups = {};

      entities.forEach(entity => {
        const groupValue = ${groupAccessor} || 'Unknown';
        if (!groups[groupValue]) groups[groupValue] = [];
        groups[groupValue].push(entity);
      });

      let html = '';
      Object.keys(groups).sort().forEach(groupName => {
        const groupEntities = groups[groupName];
        html += '<div style="margin-bottom: 24px;">';
        html += '<div class="group-header">' + groupName + ' (' + groupEntities.length + ')</div>';
        html += '<ul style="list-style: none; padding: 0;">';
        groupEntities.forEach(e => {
          html += '<li style="padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05);">' + (e.entityName || e.entityId) + '</li>';
        });
        html += '</ul></div>';
      });

      document.getElementById('report-content').innerHTML = html;
    }`;
    }

    /**
     * Generate aggregate statistics queries for report
     */
    function generateAggregateQueries() {
      const hasStats = Object.keys(aggregateStats).some(et => aggregateStats[et].length > 0);
      if (!hasStats) return '';

      let code = 'const aggregateData = {};\n\n';
      let fetchFunctions = [];
      let entityTypeCounters = {};

      Object.entries(aggregateStats).forEach(([entityType, stats]) => {
        if (stats.length === 0) return;

        if (!aggregateData[entityType]) {
          code += `aggregateData['${entityType}'] = {};\n`;
        }

        stats.forEach((stat) => {
          const statId = `${entityType}_${stat.id}`;
          const field = stat.field ? `field: "${stat.field}"` : '';
          const args = [`entityType: "${entityType}"`, field].filter(Boolean).join(', ');

          const resultFields = stat.operation === 'COUNT' ? 'count' :
            ['SUM', 'AVG', 'MIN', 'MAX'].includes(stat.operation) ? 'sum\n          avg\n          min\n          max' : 'count';

          code += `
async function fetchAggregateStat_${statId}() {
  const query = \`
    query AggregateStat${statId} {
      aggregateQuery {
        aggregateEntities(${args}) {
          ${resultFields}
        }
      }
    }
  \`;

  const response = await fetch(serviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': bearerToken },
    body: JSON.stringify({ query })
  });

  const result = await response.json();
  if (result.errors) throw new Error(result.errors[0].message);
  aggregateData['${entityType}']['${stat.id}'] = result.data.aggregateQuery.aggregateEntities;
}
`;
          fetchFunctions.push(`fetchAggregateStat_${statId}()`);
        });
      });

      code += `
async function fetchAllAggregates() {
  await Promise.all([${fetchFunctions.join(', ')}]);
  renderAggregateStats();
}
`;

      return code;
    }

    /**
     * Generate aggregate statistics rendering code
     */
    function generateAggregateRenderer() {
      const hasStats = Object.keys(aggregateStats).some(et => aggregateStats[et]?.length > 0);
      if (!hasStats) return '';

      let code = `
function renderAggregateStats() {
  // Render stats for each entity type
`;

      Object.entries(aggregateStats).forEach(([entityType, stats]) => {
        if (!stats || stats.length === 0) return;

        const safeId = entityType.replace(/\./g, '_');
        code += `
  // Stats for ${entityType}
  const container_${safeId} = document.getElementById('aggregate-stats-${safeId}');
  if (container_${safeId}) {
    let html = '<div class="aggregate-stats-container">';
`;

        stats.forEach((stat) => {
          const label = escapeHTML(stat.label || `${stat.operation}${stat.field ? ' ' + stat.field : ''}`);
          const operation = stat.operation;

          code += `
    // ${label}
    const data = aggregateData['${entityType}']?.['${stat.id}'];
    if (data) {
`;

          if (operation === 'COUNT') {
            code += `      html += \`<div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">\${(data.count || 0).toLocaleString()}</div>
      </div>\`;
`;
          } else if (operation === 'SUM') {
            code += `      html += \`<div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">\${(data.sum || 0).toLocaleString()}</div>
      </div>\`;
`;
          } else if (operation === 'AVG') {
            code += `      html += \`<div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">\${(data.avg || 0).toFixed(2)}</div>
      </div>\`;
`;
          } else if (operation === 'MIN') {
            code += `      html += \`<div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">\${(data.min || 0).toLocaleString()}</div>
      </div>\`;
`;
          } else if (operation === 'MAX') {
            code += `      html += \`<div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">\${(data.max || 0).toLocaleString()}</div>
      </div>\`;
`;
          }

          code += `    }
`;
        });

        code += `    html += '</div>';
    container_${safeId}.innerHTML = html;
  }
`;
      });

      code += `}
`;

      return code;
    }

    /**
     * Generate CSS for aggregate stat cards
     */
    function generateAggregateCSS() {
      const hasStats = Object.keys(aggregateStats).some(et => aggregateStats[et]?.length > 0);
      if (!hasStats) return '';

      return `
    .aggregate-stats-container {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
      padding: 20px;
      background: rgba(176, 132, 255, 0.05);
      border-radius: 12px;
      border: 1px solid rgba(176, 132, 255, 0.2);
    }

    .stat-card {
      background: rgba(0, 217, 255, 0.1);
      border: 1px solid rgba(0, 217, 255, 0.3);
      border-radius: 8px;
      padding: 20px;
      text-align: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .stat-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 16px rgba(0, 217, 255, 0.2);
    }

    .stat-label {
      font-size: 12px;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .stat-value {
      font-size: 32px;
      font-weight: bold;
      color: #00d9ff;
      line-height: 1.2;
    }
`;
    }

    function generateMultiEntityReport(title, description, displayMode) {
      // Check if single-entity mode (use templates) or multi-entity mode (use hierarchical)
      const isSingleEntity = selectedEntityTypes.length === 1;

      if (isSingleEntity) {
        return generateSingleEntityReport(title, description, displayMode);
      }

      // Multi-entity hierarchical report
      const queries = generateGraphQLQueries();
      const displayFunction = generateHierarchicalDisplay(displayMode);
      const helperFunctions = generateHelperFunctions();

      // Escape special characters for safe embedding in HTML
      const escapedTitle = escapeHTML(sanitizeInput(title, CONFIG.MAX_TITLE_LENGTH));
      const escapedDesc = description ? escapeHTML(sanitizeInput(description, CONFIG.MAX_DESCRIPTION_LENGTH)) : '';

      // Generate aggregate components
      const aggregateQueries = generateAggregateQueries();
      const aggregateRenderer = generateAggregateRenderer();
      const aggregateCSS = generateAggregateCSS();

      return `<!DOCTYPE html>
<html>
<head>
  <title>${escapedTitle}</title>
  <style>
    ${generateReportCSS(displayMode)}
    ${aggregateCSS}
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapedTitle}</h1>
    ${escapedDesc ? `<p>${escapedDesc}</p>` : ''}
  </div>

  <div id="loading">⏳ Loading data...</div>

  ${aggregateStats.length > 0 ? '<div id="aggregate-stats"></div>' : ''}

  <div class="container">
    <div id="report-content"></div>
  </div>

  <script>
    var serviceUrl = '';
    var bearerToken = '';

    ${helperFunctions}

    ${queries}

    ${aggregateQueries}

    ${aggregateRenderer}

    ${displayFunction}

    async function main() {
      try {
        ${aggregateStats.length > 0 ? 'await fetchAllAggregates();' : ''}
        await fetchAllData();
        document.getElementById('loading').style.display = 'none';
      } catch (error) {
        document.getElementById('loading').innerHTML = '❌ Error: ' + error.message;
        document.getElementById('loading').style.backgroundColor = '#cb253e';
      }
    }

    function receiveHubToken(event) {
      const config = event?.data?.data || event?.data?.config;
      if (event?.data?.type === 'apiConfig' && config?.token?.length && config?.endPoint?.length) {
        bearerToken = config?.token;
        serviceUrl = config?.endPoint;
        main();
      }
    }

    window.addEventListener('message', receiveHubToken, false);
  <\/script>
</body>
</html>`;
    }

    function generateGraphQLQueries() {
      let code = 'const entityData = {};\n\n';

      selectedEntityTypes.forEach(entityType => {
        const entity = schema.entityTypes.find(et => et.name === entityType);
        const fields = getFieldsNeededForEntity(entityType);

        const hasBasic = fields.some(f => f.location === 'basic');
        const hasTags = fields.some(f => f.location === 'tag');
        const hasProperties = fields.some(f => f.location === 'property');
        const namespaces = [...new Set(
          fields.filter(f => f.location.startsWith('namespace:')).map(f => f.location.split(':')[1])
        )];
        const overrideQuery = getQueryOverrideForEntity(entityType);
        const defaultQueryTemplate = `
    query GetEntities(\\$first: Int!, \\$entityType: [String!]) {
      entityQuery {
        queryEntities(first: \\$first, entityType: \\$entityType) {
          totalCount
          entities {
            ${hasBasic ? fields.filter(f => f.location === 'basic').map(f => f.name).join('\n            ') : 'entityId\n            entityName\n            entityType'}
            ${hasTags ? 'tags { key value }' : ''}
            ${hasProperties ? 'properties { name value }' : ''}
            ${namespaces.length > 0 ? `namespaces {
              name
              properties { name value }
            }` : ''}
          }
        }
      }
    }
  `;
        const querySnippet = overrideQuery
          ? `const query = ${JSON.stringify(overrideQuery)};`
          : `const query = \`${defaultQueryTemplate}\`;`;

        code += `async function fetch${entityType.replace(/\./g, '_')}() {
  ${querySnippet}

  const variables = {
    first: 1000,
    entityType: ["${entityType}"]
  };

  const response = await fetch(serviceUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': bearerToken
    },
    body: JSON.stringify({ query, variables })
  });

  const result = await response.json();
  if (result.errors) throw new Error(result.errors[0].message);

  entityData["${entityType}"] = result.data.entityQuery.queryEntities.entities;
  return entityData["${entityType}"];
}

`;
      });

      code += `async function fetchAllData() {
  ${selectedEntityTypes.map(et => `await fetch${et.replace(/\./g, '_')}();`).join('\n  ')}
  displayHierarchicalData();
}`;

      return code;
    }

    function generateHierarchicalDisplay(displayMode) {
      const configPayload = JSON.stringify({
        entityTypes: selectedEntityTypes,
        relationships,
        selectedFields
      });

      return `
    const builderConfig = ${configPayload};
    const layoutMode = '${displayMode}';
    ${generateReportRendererClass()}

    function displayHierarchicalData() {
      const renderer = new ReportRenderer(builderConfig, entityData);
      let html = '';
      if (layoutMode === 'hierarchical') {
        html = renderer.renderHierarchy();
      } else if (layoutMode === 'table') {
        html = renderer.renderTable();
      } else if (layoutMode === 'timeline') {
        html = renderer.renderTimeline();
      } else {
        html = renderer.renderCards();
      }
      document.getElementById('report-content').innerHTML = html;
    }
      `;
    }

    function generateFieldAccessor(entityVar, field) {
      if (field.location === 'basic') {
        return `${entityVar}.${field.name}`;
      } else if (field.location === 'tag') {
        return `getTagValue(${entityVar}.tags, '${field.name}')`;
      } else if (field.location === 'property') {
        return `getPropertyValue(${entityVar}.properties, '${field.name}')`;
      } else if (field.location.startsWith('namespace:')) {
        const ns = field.location.split(':')[1];
        return `getNamespaceProperty(${entityVar}, '${ns}', '${field.name}')`;
      }
    }

    function generateReportRendererClass() {
      return `
    class ReportRenderer {
      constructor(config, entityData) {
        this.config = config || {};
        this.entityData = entityData || {};
        this.relationships = this.config.relationships || [];
        this.entityTypes = this.config.entityTypes || [];
        this.selectedFields = this.config.selectedFields || {};
      }

      renderHierarchy() {
        const nodes = this.buildNodes();
        if (!nodes.length) {
          return '<div class="entity-item">No matching data</div>';
        }
        return nodes.map(node => this.renderHierarchyNode(node, 0)).join('');
      }

      renderHierarchyNode(node, depth) {
        const containerClass = depth === 0 ? 'hierarchy-root' : 'hierarchy-level';
        const safeId = node.entityType.replace(/\\./g, '_');
        let html = '<div class="' + containerClass + '">';
        html += '<h4>' + node.entityType + '</h4>';
        html += '<div id="aggregate-stats-' + safeId + '"></div>';
        html += this.renderFields(node);
        node.children.forEach(child => {
          html += this.renderHierarchyNode(child, depth + 1);
        });
        html += '</div>';
        return html;
      }

      renderCards() {
        const nodes = this.buildNodes();
        if (!nodes.length) return '<div class="entity-item">No matching data</div>';
        return nodes.map(node => this.renderCard(node)).join('');
      }

      renderCard(node) {
        const safeId = node.entityType.replace(/\\./g, '_');
        let html = '<div class="preview-card">';
        html += '<h4>' + node.entityType + '</h4>';
        html += '<div id="aggregate-stats-' + safeId + '"></div>';
        html += '<div>' + (this.getDisplayValue(node.entityType, node.entity) || '-') + '</div>';
        if (node.children.length) {
          html += '<div style="margin-top: 12px;">';
          node.children.forEach(child => {
            html += this.renderCard(child);
          });
          html += '</div>';
        }
        html += '</div>';
        return html;
      }

      renderTable() {
        const rows = this.collectRows();
        const colCount = this.entityTypes.length || 1;
        let html = '';

        // Add aggregate stats containers for each entity type
        this.entityTypes.forEach(type => {
          const safeId = type.replace(/\\./g, '_');
          html += '<h4>' + type + '</h4>';
          html += '<div id="aggregate-stats-' + safeId + '"></div>';
        });

        html += '<table><thead><tr>';
        this.entityTypes.forEach(type => {
          html += '<th>' + type + '</th>';
        });
        html += '</tr></thead><tbody>';
        if (!rows.length) {
          html += '<tr><td colspan="' + colCount + '">No matching data</td></tr>';
        } else {
          rows.forEach(row => {
            html += '<tr>';
            row.forEach((node, idx) => {
              const value = node ? this.getDisplayValue(this.entityTypes[idx], node.entity) || '-' : '-';
              html += '<td>' + value + '</td>';
            });
            html += '</tr>';
          });
        }
        html += '</tbody></table>';
        return html;
      }

      renderTimeline() {
        const rows = this.collectRows();
        if (!rows.length) return '<div class="entity-item">No timeline data</div>';
        let html = '<div class="timeline">';
        rows.forEach(row => {
          const labels = row.map((node, idx) => {
            return node ? (this.getDisplayValue(this.entityTypes[idx], node.entity) || this.entityTypes[idx]) : null;
          }).filter(Boolean);
          html += '<div class="timeline-step">';
          html += '<div style="font-weight: 600;">' + labels.join(' → ') + '</div>';
          html += '</div>';
        });
        html += '</div>';
        return html;
      }

      renderFields(node) {
        const fields = this.getFields(node.entityType);
        if (!fields.length) return '';
        let html = '<div class="entity-item">';
        fields.forEach(field => {
          const value = this.getFieldValue(node.entity, field) || '-';
          if (field.showLabel === false) {
            html += '<div>' + value + '</div>';
          } else {
            html += '<div><strong>' + field.name + ':</strong> ' + value + '</div>';
          }
        });
        html += '</div>';
        return html;
      }

      getFields(entityType) {
        return this.selectedFields?.[entityType] || [];
      }

      getFieldValue(entity, field) {
        if (!entity || !field) return '';
        if (field.location === 'basic') {
          return entity[field.name];
        }
        if (field.location === 'tag') {
          return getTagValue(entity.tags, field.name);
        }
        if (field.location === 'property') {
          return getPropertyValue(entity.properties, field.name);
        }
        if (field.location?.startsWith('namespace:')) {
          const ns = field.location.split(':')[1];
          return getNamespaceProperty(entity, ns, field.name);
        }
        return '';
      }

      getDisplayValue(entityType, entity) {
        const fields = this.getFields(entityType);
        const preferred = fields.find(f => f.zone === 'header') || fields[0];
        if (preferred) {
          return this.getFieldValue(entity, preferred);
        }
        return entity?.entityName || entity?.entityId || '';
      }

      buildNodes() {
        if (!this.entityTypes.length) return [];
        const roots = this.entityData[this.entityTypes[0]] || [];
        return roots.map(root => this.buildNode(0, root));
      }

      buildNode(depth, entity) {
        const entityType = this.entityTypes[depth];
        const node = { entityType, entity, children: [] };
        if (depth < this.relationships.length) {
          const rel = this.relationships[depth];
          const children = (this.entityData[rel.to] || []).filter(child => {
            const parentValue = this.getRelationshipValue(entity, rel.fromField, rel.fromLocation);
            const childValue = this.getRelationshipValue(child, rel.toField, rel.toLocation);
            return this.valuesMatch(parentValue, childValue);
          });
          node.children = children.map(child => this.buildNode(depth + 1, child));
        }
        return node;
      }

      collectRows() {
        const nodes = this.buildNodes();
        const rows = [];
        const depthCount = this.entityTypes.length || 1;

        const traverse = (depth, node, currentRow) => {
          const nextRow = currentRow.slice();
          nextRow[depth] = node;
          if (!node.children.length || depth === depthCount - 1) {
            rows.push(nextRow);
            return;
          }
          node.children.forEach(child => traverse(depth + 1, child, nextRow));
        };

        nodes.forEach(node => {
          const seed = new Array(depthCount).fill(null);
          traverse(0, node, seed);
        });

        if (!nodes.length && this.entityTypes.length) {
          const fallback = (this.entityData[this.entityTypes[0]] || []).map(entity => {
            const row = new Array(depthCount).fill(null);
            row[0] = { entity };
            return row;
          });
          fallback.forEach(row => rows.push(row));
        }

        return rows;
      }

      getRelationshipValue(entity, fieldName, location) {
        if (!entity || !fieldName) return undefined;
        const loc = location || 'auto';
        if (loc === 'basic') {
          return entity[fieldName];
        }
        if (loc === 'tag') {
          return getTagValue(entity.tags, fieldName);
        }
        if (loc === 'property') {
          return getPropertyValue(entity.properties, fieldName);
        }
        if (loc?.startsWith && loc.startsWith('namespace:')) {
          const ns = loc.split(':')[1];
          return getNamespaceProperty(entity, ns, fieldName);
        }

        if (entity[fieldName] !== undefined && entity[fieldName] !== null) {
          return entity[fieldName];
        }

        const propertyValue = getPropertyValue(entity.properties, fieldName);
        if (propertyValue !== undefined && propertyValue !== null) {
          return propertyValue;
        }

        const tagValue = getTagValue(entity.tags, fieldName);
        if (tagValue !== undefined && tagValue !== null) {
          return tagValue;
        }

        if (entity.namespaces) {
          for (const ns of entity.namespaces) {
            const prop = ns.properties?.find(p => p.name === fieldName);
            if (prop) return prop.value;
          }
        }

        return undefined;
      }

      valuesMatch(parentValue, childValue) {
        if (parentValue === undefined || parentValue === null) return false;
        if (childValue === undefined || childValue === null) return false;
        return parentValue === childValue;
      }
    }
      `;
    }

    function generateHelperFunctions() {
      return `
    function getTagValue(tags, key) {
      if (!tags) return null;
      const tag = tags.find(t => t.key === key);
      return tag?.value;
    }

    function getPropertyValue(properties, name) {
      if (!properties) return null;
      const prop = properties.find(p => p.name === name);
      return prop?.value;
    }

    function getNamespaceProperty(entity, nsName, propName) {
      if (!entity.namespaces) return null;
      const ns = entity.namespaces.find(n => n.name === nsName);
      if (!ns?.properties) return null;
      const prop = ns.properties.find(p => p.name === propName);
      return prop?.value;
    }
      `;
    }

    function generateReportCSS(displayMode) {
      return `
    body {
      margin: 0;
      padding: 0;
      background: #000;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      color: #e0e0e0;
    }

    .header {
      background: #0f171c;
      color: white;
      padding: 20px 40px;
      border-bottom: 2px solid #00d9ff;
    }

    .header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 600;
    }

    .header p {
      margin: 8px 0 0 0;
      color: #9ca3af;
    }

    #loading {
      background: #ffe9a2;
      color: #000;
      padding: 16px;
      text-align: center;
      font-weight: 500;
    }

    .container {
      padding: 40px;
      max-width: 1400px;
      margin: 0 auto;
    }

    .hierarchy-root {
      background: rgba(0, 217, 255, 0.1);
      border: 1px solid #00d9ff;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }

    .hierarchy-level {
      margin-left: 24px;
      margin-top: 16px;
      padding-left: 20px;
      border-left: 3px solid rgba(176, 132, 255, 0.5);
    }

    .hierarchy-level h4 {
      color: #b084ff;
      margin: 0 0 12px 0;
      font-size: 16px;
    }

    .entity-item {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
    }

    .entity-item strong {
      color: #00d9ff;
      margin-right: 8px;
    }

    .entity-section {
      margin-bottom: 40px;
    }

    .entity-section h2 {
      color: #00d9ff;
      border-bottom: 2px solid rgba(0, 217, 255, 0.3);
      padding-bottom: 12px;
      margin-bottom: 20px;
    }

    .timeline {
      border-left: 2px dashed rgba(0, 217, 255, 0.4);
      padding-left: 20px;
      margin-left: 10px;
    }

    .timeline-step {
      position: relative;
      margin-bottom: 18px;
    }

    .timeline-step::before {
      content: '';
      position: absolute;
      left: -29px;
      top: 6px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #00d9ff;
      box-shadow: 0 0 8px rgba(0, 217, 255, 0.7);
    }

    .preview-card {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
      background: rgba(255, 255, 255, 0.04);
    }

    .preview-card h4 {
      margin: 0 0 8px 0;
      font-size: 14px;
      color: #00d9ff;
    }

    .preview-card {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
      background: rgba(255, 255, 255, 0.04);
    }

    .preview-card h4 {
      margin: 0 0 8px 0;
      font-size: 14px;
      color: #00d9ff;
    }

    .preview-card small {
      color: #9ca3af;
    }
      `;
    }

    // ============================================================================
    // STEP 6: DOWNLOAD REPORT
    // ============================================================================

    /**
     * Compresses HTML by removing unnecessary whitespace
     * @param {string} html - HTML string to compress
     * @returns {string} Compressed HTML
     */
    function compressHTML(html) {
      return html
        .replace(/\s+/g, ' ')              // Collapse whitespace
        .replace(/>\s+</g, '><')           // Remove space between tags
        .replace(/<!--.*?-->/g, '')        // Remove comments
        .trim();
    }

    document.getElementById('downloadBtn')?.addEventListener('click', () => {
      try {
        // Compress the HTML for smaller file size
        const compressed = compressHTML(generatedHTML);

        const blob = new Blob([compressed], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const title = sanitizeInput(
          DOMCache.get('reportTitle')?.value || 'multi_entity_report',
          CONFIG.MAX_TITLE_LENGTH
        ).replace(/\s+/g, '_').toLowerCase();
        a.download = `${title}.html`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        showError(new ReportBuilderError('Failed to download report', 'DOWNLOAD_ERROR', { error: error.message }));
      }
    });

    // ============================================================================
    // WEEK 3 FEATURES: UNDO/REDO, SAVE/LOAD, FIELD SEARCH
    // ============================================================================

    /**
     * Saves builder configuration to JSON file
     */
    function saveBuilderConfig() {
      try {
        const config = {
          version: '1.0',
          timestamp: new Date().toISOString(),
          selectedEntityTypes,
          relationships,
          selectedFields,
          relationshipLayout,
          reportTitle: sanitizeInput(DOMCache.get('reportTitle')?.value || '', CONFIG.MAX_TITLE_LENGTH),
          reportDescription: sanitizeInput(DOMCache.get('reportDescription')?.value || '', CONFIG.MAX_DESCRIPTION_LENGTH),
          displayMode: DOMCache.get('displayMode')?.value || 'hierarchical',
          customQueryOverride
        };

        const json = JSON.stringify(config, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `report-config-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        showError(new ReportBuilderError('Failed to save configuration', 'CONFIG_SAVE_ERROR', { error: error.message }));
      }
    }

    /**
     * Loads builder configuration from JSON file
     * @param {File} file - Configuration file to load
     */
    async function loadBuilderConfig(file) {
      try {
        // Validate file
        if (!file.name.endsWith('.json')) {
          throw new ReportBuilderError('Configuration file must be JSON', 'CONFIG_WRONG_TYPE');
        }

        if (file.size > 5 * 1024 * 1024) {
          throw new ReportBuilderError('Configuration file too large (max 5MB)', 'CONFIG_TOO_LARGE');
        }

        const text = await file.text();
        const config = JSON.parse(text);

        // Validate version
        if (!config.version) {
          throw new ReportBuilderError('Invalid configuration file format', 'CONFIG_INVALID');
        }

        // Validate we have a schema loaded
        if (!schema) {
          throw new ReportBuilderError('Please load a schema first before loading a configuration', 'NO_SCHEMA_LOADED');
        }

        // Restore state
        selectedEntityTypes = config.selectedEntityTypes || [];
        relationships = config.relationships || [];
        selectedFields = config.selectedFields || {};
        relationshipLayout = config.relationshipLayout || {};
        customQueryOverride = config.customQueryOverride || '';

        // Update UI
        if (config.reportTitle && DOMCache.get('reportTitle')) {
          DOMCache.get('reportTitle').value = config.reportTitle;
        }
        if (config.reportDescription && DOMCache.get('reportDescription')) {
          DOMCache.get('reportDescription').value = config.reportDescription;
        }
        if (config.displayMode && DOMCache.get('displayMode')) {
          DOMCache.get('displayMode').value = config.displayMode;
        }

        // Clear and rebuild history
        history.clear();
        history.save();

        // Rebuild UI
        displayEntitySelector();
        buildRelationships();
        displayFieldSelector();
        updateQueryInspector();

        // Show success message
        const statusContainer = DOMCache.get('schemaStatus');
        if (statusContainer) {
          const successMsg = document.createElement('div');
          successMsg.className = 'success';
          successMsg.style.marginTop = '12px';
          successMsg.innerHTML = '✅ Configuration loaded successfully!';
          statusContainer.appendChild(successMsg);
          setTimeout(() => successMsg.remove(), 3000);
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          showError(new ReportBuilderError('Invalid JSON in configuration file', 'CONFIG_JSON_ERROR', { error: error.message }));
        } else {
          showError(error);
        }
      }
    }

    /**
     * Filters field items based on search query
     * @param {string} query - Search query
     */
    function filterFields(query) {
      const items = document.querySelectorAll('.field-item');
      const lowerQuery = query.toLowerCase().trim();

      items.forEach(item => {
        if (!lowerQuery) {
          item.style.display = '';
          return;
        }

        const fieldName = (item.dataset.field || '').toLowerCase();
        const fieldLocation = (item.dataset.location || '').toLowerCase();
        const entityType = (item.dataset.entity || '').toLowerCase();

        const matches = fieldName.includes(lowerQuery) ||
                       fieldLocation.includes(lowerQuery) ||
                       entityType.includes(lowerQuery);

        item.style.display = matches ? '' : 'none';
      });
    }

    /**
     * Validates GraphQL query in the inspector
     */
    function validateQueryInspector() {
      const textarea = DOMCache.get('queryInspectorText');
      if (!textarea) return;

      const query = textarea.value.trim();
      if (!query) return;

      const validation = validateGraphQLQuery(query);
      const statusEl = DOMCache.get('queryInspectorStatus');

      if (statusEl) {
        if (validation.valid) {
          statusEl.textContent = '✓ Query syntax looks good';
          statusEl.style.color = CONFIG.COLORS.SUCCESS;
        } else {
          statusEl.textContent = '⚠ Issues: ' + validation.errors.join(', ');
          statusEl.style.color = CONFIG.COLORS.ERROR;
        }
      }
    }

    // ============================================================================
    // EVENT LISTENERS FOR NEW FEATURES
    // ============================================================================

    // Undo/Redo buttons
    DOMCache.get('undoBtn')?.addEventListener('click', () => history.undo());
    DOMCache.get('redoBtn')?.addEventListener('click', () => history.redo());

    // Keyboard shortcuts for undo/redo
    document.addEventListener('keydown', (e) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      if (modKey && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        history.undo();
      } else if (modKey && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        history.redo();
      }
    });

    // Save/Load configuration
    DOMCache.get('saveConfigBtn')?.addEventListener('click', saveBuilderConfig);
    DOMCache.get('loadConfigBtn')?.addEventListener('click', () => {
      DOMCache.get('loadConfigFile')?.click();
    });
    DOMCache.get('loadConfigFile')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        await loadBuilderConfig(file);
        // Reset file input so same file can be loaded again
        e.target.value = '';
      }
    });

    // Field search
    const fieldSearchDebounced = debounce(filterFields, 300);
    DOMCache.get('fieldSearch')?.addEventListener('input', (e) => {
      fieldSearchDebounced(e.target.value);
    });

    // Query validation on inspector change
    DOMCache.get('queryInspectorText')?.addEventListener('input', debounce(validateQueryInspector, 500));

    // Show toolbar when schema is loaded
    function showToolbar() {
      const toolbar = DOMCache.get('toolbarCard');
      if (toolbar) toolbar.style.display = 'block';
    }

    // Call showToolbar when schema is successfully loaded (already done in schema load handler)
    // Just need to ensure it's visible
    const originalDisplayEntitySelector = displayEntitySelector;
    displayEntitySelector = function() {
      originalDisplayEntitySelector();
      showToolbar();
    };

    // Console helper for debugging
    window.reportBuilderDebug = {
      getState: () => ({
        schema: schema?.entityTypes?.length || 0,
        selectedEntityTypes,
        relationships,
        selectedFields,
        historySize: history.stack.length,
        historyPointer: history.pointer
      }),
      getHistory: () => history.stack,
      clearHistory: () => history.clear(),
      getConfig: CONFIG
    };

    // ============================================================================
    // AGGREGATE REPORT FUNCTIONALITY
    // ============================================================================

    /**
     * Add a new aggregate statistic card for an entity type
     * @param {string} entityType - The entity type to add stat for
     */
    function addAggregateStat(entityType) {
      if (!entityType) return;

      if (!aggregateStats[entityType]) {
        aggregateStats[entityType] = [];
      }

      const id = Date.now();
      const stat = {
        id,
        operation: 'COUNT',
        field: '',
        label: ''
      };

      aggregateStats[entityType].push(stat);
      renderAggregateStatsForEntity(entityType);
      history.save();
    }

    /**
     * Remove an aggregate statistic
     * @param {string} entityType - The entity type
     * @param {number} id - The statistic ID to remove
     */
    function removeAggregateStat(entityType, id) {
      if (!aggregateStats[entityType]) return;

      aggregateStats[entityType] = aggregateStats[entityType].filter(s => s.id !== id);
      renderAggregateStatsForEntity(entityType);
      history.save();
    }

    /**
     * Update an aggregate statistic
     * @param {string} entityType - The entity type
     * @param {number} id - The statistic ID
     * @param {string} field - The field to update
     * @param {*} value - The new value
     */
    function updateAggregateStat(entityType, id, field, value) {
      if (!aggregateStats[entityType]) return;

      const stat = aggregateStats[entityType].find(s => s.id === id);
      if (stat) {
        stat[field] = value;

        // If operation changes and doesn't need a field, clear it
        if (field === 'operation' && value === 'COUNT') {
          stat.field = '';
        }

        renderAggregateStatsForEntity(entityType);
        history.save();
      }
    }

    /**
     * Render aggregate statistics UI for a specific entity type
     * @param {string} entityType - The entity type
     */
    function renderAggregateStatsForEntity(entityType) {
      const container = document.getElementById(`aggregateStats_${entityType.replace(/\./g, '_')}`);
      if (!container) return;

      const stats = aggregateStats[entityType] || [];

      if (stats.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: #9ca3af; padding: 12px; font-size: 13px;">No aggregate statistics. Click "+ Add Stat" to create one.</div>';
        return;
      }

      const entity = schemaCache.getEntity(entityType) || schema?.entityTypes.find(e => e.name === entityType);
      const fields = entity?.fields?.basic || [];

      container.innerHTML = stats.map(stat => {
        const showFieldSelector = ['SUM', 'AVG', 'MIN', 'MAX'].includes(stat.operation);
        const fieldOptions = fields.map(f =>
          `<option value="${f}" ${stat.field === f ? 'selected' : ''}>${f}</option>`
        ).join('');

        return `
          <div class="aggregate-stat-item">
            <div>
              <label>Operation</label>
              <select onchange="updateAggregateStat('${entityType}', ${stat.id}, 'operation', this.value)">
                <option value="COUNT" ${stat.operation === 'COUNT' ? 'selected' : ''}>COUNT</option>
                <option value="SUM" ${stat.operation === 'SUM' ? 'selected' : ''}>SUM</option>
                <option value="AVG" ${stat.operation === 'AVG' ? 'selected' : ''}>AVG</option>
                <option value="MIN" ${stat.operation === 'MIN' ? 'selected' : ''}>MIN</option>
                <option value="MAX" ${stat.operation === 'MAX' ? 'selected' : ''}>MAX</option>
              </select>
              ${showFieldSelector ? `
                <label style="margin-top: 8px;">Field</label>
                <select onchange="updateAggregateStat('${entityType}', ${stat.id}, 'field', this.value)">
                  <option value="">Select field...</option>
                  ${fieldOptions}
                </select>
              ` : ''}
            </div>
            <div>
              <label>Label (optional)</label>
              <input type="text" value="${escapeHTML(stat.label)}" placeholder="e.g., Total Count"
                     onchange="updateAggregateStat('${entityType}', ${stat.id}, 'label', this.value)">
            </div>
            <div>
              <button type="button" class="stat-remove-btn" onclick="removeAggregateStat('${entityType}', ${stat.id})">✕</button>
            </div>
          </div>
        `;
      }).join('');
    }

    // Make aggregate functions globally accessible
    window.addAggregateStat = addAggregateStat;
    window.removeAggregateStat = removeAggregateStat;
    window.updateAggregateStat = updateAggregateStat;

    console.log('🔧 TP Report Builder initialized');
    console.log('💡 Use window.reportBuilderDebug.getState() to inspect current state');
