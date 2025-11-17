# TP Custom Report Builder

**Version:** 2.3 (Client-Side Aggregation)
**Updated:** 2025-11-17

Build custom GraphQL-based reports for TP with an intuitive visual interface. No backend required - runs entirely in your browser!

---

## 🚀 Quick Start

### 1. Discover Your Schema
1. Upload **[tp_schema_discovery.html](tp_schema_discovery.html)** to TP
2. Run it to discover all entity types via GraphQL introspection
3. Download the generated schema JSON file

### 2. Build Your Report
1. Open **[tp_report_builder.html](tp_report_builder.html)** in your browser
2. Upload the schema JSON from step 1
3. Select entity types (e.g., Spaces, Apps, Repositories)
4. Define relationships between entities
5. Choose fields to display and arrange in layout zones
6. Generate and download your report HTML

### 3. Deploy Your Report
1. Upload the generated HTML to TP
2. The report fetches live data automatically via authenticated GraphQL API

**That's it!** No server, no npm install, no dependencies.

---

## ✨ Key Features

### Core Functionality
- ✅ **Visual Entity Builder** - Drag-and-drop entity relationship canvas
- ✅ **Auto Relationship Detection** - Finds common fields automatically
- ✅ **Multiple Display Modes** - Hierarchical tree, tables, cards, timeline
- ✅ **Live Preview** - See report layout before generating
- ✅ **Custom Query Override** - Full GraphQL control when needed
- ✅ **Field Layout Zones** - Header, Summary, Detail sections
- 📊 **Aggregate Statistics** - Add summary stat cards (COUNT, SUM, AVG, MIN, MAX)

### v2.0 Enhancements
- 🎛️ **Undo/Redo** - 50-action history with keyboard shortcuts (Ctrl/Cmd+Z)
- 💾 **Save/Load Configurations** - Export/import complete report setups
- 🔍 **Field Search** - Real-time filtering for large entity types
- ⚡ **Performance** - 85% fewer DOM queries, debounced rendering
- 🛡️ **Security** - XSS protection, input validation, file size limits
- 📦 **Compressed Output** - 30-40% smaller HTML files
- 🐛 **Debug Console** - `window.reportBuilderDebug` helper

### v2.3 Improvements (Nov 2025)
- 📊 **Client-Side Aggregation** - Calculate stats from fetched data (no server-side API required)
- 🎯 **Top-Level Summary Cards** - Aggregates display as prominent cards above report content
- 🔧 **Inspect Generated HTML** - New debug button to view raw HTML source before upload
- 🐛 **Template Literal Escaping** - Fixed JavaScript syntax errors in generated reports
- ✨ **Enhanced Field Selection** - Aggregate operations now support all field types (properties, tags, namespaces)

---

## 📋 Understanding TP Entity Types

### Field Locations

Fields in TP entities come from 4 different locations:

| Location | Example | GraphQL Access |
|----------|---------|----------------|
| **Basic** | `entityId`, `entityName` | Direct property on entity |
| **Tags** | `environment`, `team` | `tags { key value }` array |
| **Properties** | `version`, `status` | `properties { name value }` array |
| **Namespaces** | `k8s.namespace`, `git.repo` | `namespaces { name properties { name value } }` |

### Common Entity Types

```
Portfolio:
  - Tanzu.Portfolio.Repository
  - Tanzu.Portfolio.Application
  - Tanzu.Portfolio.BusinessApp
  - Tanzu.Portfolio.Space

TAP (Application Platform):
  - Tanzu.TAP.Workload
  - Tanzu.TAP.Deliverable

TAS (Application Service):
  - Tanzu.TAS.Application
  - Tanzu.TAS.Space
  - Tanzu.TAS.Organization

Infrastructure:
  - Tanzu.TKG.Cluster
  - Tanzu.VM
  - Tanzu.Container
  - Tanzu.Database
```

**Important:** Entity type names use dot notation (e.g., `Tanzu.Portfolio.Space`), while GraphQL schema types use underscores (e.g., `Entity_Tanzu_Portfolio_Space_Type`). The builder handles this automatically.

---

## 🔧 How It Works

```
┌──────────────────────────────────────┐
│  Schema Discovery                    │
│  (tp_schema_discovery.html)          │
│                                      │
│  • Upload to TP                      │
│  • GraphQL introspection             │
│  • Discovers all entity types        │
│  • Exports schema.json               │
└────────────┬─────────────────────────┘
             │
             ▼ schema.json
┌──────────────────────────────────────┐
│  Report Builder                      │
│  (tp_report_builder.html)            │
│                                      │
│  • Opens locally in browser          │
│  • Loads schema.json                 │
│  • Visual entity selection           │
│  • Relationship mapping              │
│  • Field configuration               │
│  • Generates self-contained HTML     │
└────────────┬─────────────────────────┘
             │
             ▼ report.html
┌──────────────────────────────────────┐
│  Generated Report                    │
│  (uploaded to TP)                    │
│                                      │
│  • Runs inside TP                    │
│  • Fetches live data via GraphQL    │
│  • Authenticated via postMessage     │
│  • Renders hierarchical data         │
└──────────────────────────────────────┘
```

### Why Two HTML Files?

**tp_schema_discovery.html**
- Runs **inside TP** to discover the API schema
- Uses GraphQL introspection to find all entity types
- Extracts field information and sample data
- One-time setup per schema version

**tp_report_builder.html**
- Runs **locally** in your browser
- Uses the discovered schema to build reports
- Works offline once you have the schema
- Can be reused for many different reports

---

## 🎯 Common Use Cases

### 1. Organization → Spaces → Apps Hierarchy
```
Entities:  Tanzu.TAS.Organization
           Tanzu.TAS.Space
           Tanzu.TAS.Application

Display:   Hierarchical Tree
Result:    Nested view showing orgs containing spaces containing apps
```

### 2. Portfolio Repository Report
```
Entities:  Tanzu.Portfolio.Repository

Fields:    name, url, language, lastCommitDate
Display:   Summary + Table
Result:    Count of repos plus sortable table
```

### 3. Application Journey Timeline
```
Entities:  Tanzu.Portfolio.Application
           Tanzu.TAP.Workload
           Tanzu.TAS.Application

Display:   Journey Timeline
Result:    Application lifecycle across platforms
```

---

## 🛠️ Advanced Features

### Custom GraphQL Queries

Override auto-generated queries for advanced filtering:

1. Configure your report normally
2. Open **Query Inspector** (Step 5)
3. Edit the GraphQL query
4. Click **Apply Query Override**
5. Generate report

**Example with Filtering:**
```graphql
query GetActiveApps($first: Int!, $entityType: [String!]) {
  entityQuery {
    queryEntities(
      first: $first
      entityType: $entityType
      filter: "status eq 'running'"
    ) {
      totalCount
      entities {
        entityId
        entityName
        tags { key value }
        properties { name value }
      }
    }
  }
}
```

### Aggregate Statistics

Add summary statistic cards at the top of your reports for dashboard-style insights:

**How to Use:**
1. Build your report normally (select entities and fields)
2. In **Step 4** (Select Fields), each entity has an **"📊 Aggregate Statistics"** section
3. Click **"+ Add Stat"** for that entity type
4. Configure:
   - **Operation** - COUNT, SUM, AVG, MIN, MAX
   - **Field** - Which field to aggregate (for numeric operations like SUM/AVG)
   - **Label** - Custom label for your stat (e.g., "Total Instances")
5. Generate report - stats appear as **summary cards at the top** of the report

**Example Report Layout:**
```
┌─────────────────────────────────────┐
│ Multi-Entity Report                 │
├─────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌───────┐│  ← Summary Cards (Top)
│ │Total Inst│ │Avg Memory│ │Count  ││
│ │267       │ │1024 MB   │ │42     ││
│ │Application│ │Space    │ │Space  ││
│ └──────────┘ └──────────┘ └───────┘│
├─────────────────────────────────────┤
│ Tanzu.TAS.Space                     │  ← Entity Details
│   • Space 1                         │
│     └─ Application 1                │
│     └─ Application 2                │
└─────────────────────────────────────┘
```

**Supported Operations:**
- **COUNT** - Total number of entities (e.g., "42 Spaces")
- **SUM** - Sum of numeric field values (e.g., "267 total instances")
- **AVG** - Average of numeric field (e.g., "1024 MB average")
- **MIN** - Minimum value across all entities
- **MAX** - Maximum value across all entities

**How It Works:**
- **Client-Side Calculation** - Aggregates are computed from fetched entity data in the browser
- **Per-Entity Stats** - Each entity type can have different aggregations
- **Top-Level Display** - All stats appear as cards at the top for quick insights
- **Responsive Grid** - Cards automatically arrange based on screen size

**Example Use Cases:**
- Total application instances across all spaces
- Average memory usage per organization
- Count of repositories by team
- Maximum build time across all pipelines

### Configuration Management

**Save Configuration:**
1. Build your report completely
2. Click **💾 Save Config** in toolbar
3. Downloads `report-config-YYYY-MM-DD.json`

**Load Configuration:**
1. Load schema first (required)
2. Click **📂 Load Config**
3. Select your saved JSON file
4. Report configuration restored instantly

**Use Cases:**
- Share report templates with team members
- Create a library of common report types
- Backup complex multi-entity configurations
- Version control your report definitions

### Field Search & Filtering

For entities with 100+ fields:

1. Go to **Step 4: Select Fields**
2. Type in the search box
3. Results filter in real-time
4. Search by:
   - Field name: `"entityId"`, `"status"`
   - Location: `"tag"`, `"property"`, `"namespace"`
   - Entity: `"Portfolio"`, `"TAS"`

**Tips:**
- Partial matches work: `"id"` finds `entityId`, `guid`, etc.
- Case-insensitive
- Clears when search is empty

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+Z` | Undo last change |
| `Ctrl/Cmd+Shift+Z` | Redo last undone change |
| `Ctrl/Cmd+Y` | Redo (Windows/Linux only) |

**50-action history** - Experiment freely!

---

## 🐛 Troubleshooting

### Common Issues

**"No entity types found in schema"**
- Schema JSON is empty or invalid
- Re-run schema discovery
- Ensure your TP instance has entity data

**"Please load a schema first before loading a configuration"**
- Upload schema JSON before loading config
- Config requires matching schema

**Relationships not auto-detected**
- Entities don't have common fields
- Use manual relationship definition in Step 3
- Check field locations (basic vs tag vs property)

**Fields missing in generated report**
- Fields not selected in Step 4
- Fields not assigned to a layout zone
- Check Query Inspector for actual fields in query

**"Unbalanced braces in query"**
- Syntax error in custom query override
- Use Query Inspector validation
- Check for matching `{` `}` and `(` `)`

**Report shows "No matching data"**
- Relationship field values don't match
- Check actual data has matching values
- Verify field locations are correct

### Debug Tools

**Console Helper:**
```javascript
// In browser DevTools console:

// Get current state
window.reportBuilderDebug.getState()

// View undo/redo history
window.reportBuilderDebug.getHistory()

// Check configuration
window.reportBuilderDebug.getConfig()

// Clear history
window.reportBuilderDebug.clearHistory()
```

**Debug Checklist:**
- [ ] Schema loaded successfully?
- [ ] Entity types selected?
- [ ] Relationships defined (if multi-entity)?
- [ ] Fields selected and assigned to zones?
- [ ] Check browser console for errors
- [ ] Try debug helper commands above

---

## 🔒 Security & Privacy

- ✅ **Client-Side Only** - All processing in your browser
- ✅ **No Data Upload** - Nothing sent to external servers
- ✅ **XSS Protected** - All inputs sanitized and escaped
- ✅ **Input Validated** - File sizes, types, lengths enforced
- ✅ **No Tracking** - Zero analytics or telemetry
- ✅ **No Dependencies** - No CDN or third-party scripts

**File Size Limits:**
- Schema files: 50MB max
- Config files: 5MB max

**Input Length Limits:**
- Report title: 200 chars
- Description: 1000 chars
- All other inputs: 500 chars

---

## 📊 Performance

### v2.0 Optimizations

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| DOM Queries | 15-20/action | 2-3/action | **85% reduction** |
| Re-render Delay | Immediate | 150ms debounce | **Smoother UX** |
| HTML File Size | 100-150KB | 60-90KB | **30-40% smaller** |
| Field Search | N/A | <50ms | **New feature** |
| Memory Leaks | Yes | None | **Fixed** |

### Browser Requirements

- **Modern browser** (Chrome, Firefox, Safari, Edge)
- **JavaScript** enabled
- **ES6+** support
- **APIs used:** AbortController, optional chaining, nullish coalescing

---

## 💡 Tips & Best Practices

### Working with Large Schemas

1. **Use field search** - Don't scroll through 200 fields
2. **Select needed fields only** - Smaller queries, faster reports
3. **Save configurations** - Complex setups can be reused
4. **Use undo** - Experiment without fear
5. **Test with preview** - Verify before generating

### Building Complex Reports

1. **Start simple** - Begin with 2-3 entities
2. **Verify relationships** - Use the visual canvas
3. **Add fields gradually** - Don't select everything at once
4. **Test incrementally** - Generate and test often
5. **Save milestones** - Save config at each major step

### Sharing with Team

1. **Save configuration** to JSON
2. **Share schema + config** files
3. **Document purpose** - Add comments in report description
4. **Version control** - Keep configs in git
5. **Template library** - Organize by use case

---

## 📦 What's Included

```
tp_report_builder.html       Main report builder (open locally)
tp_schema_discovery.html     Schema discovery tool (upload to TP)
builder.js                   Report builder JavaScript
README.md                    This documentation
IMPROVEMENTS_SUMMARY.md      Technical change log
```

### Zero Dependencies

- ✅ No npm install
- ✅ No build process
- ✅ No backend server
- ✅ No database
- ✅ Works offline (after schema discovery)
- ✅ Pure HTML/CSS/JavaScript

---

## 🚀 Version History

### v2.0 (2025-11-14) - Enhanced Edition

**Week 1: Security & Critical Fixes**
- Fixed XSS vulnerabilities
- Added comprehensive input validation
- Fixed memory leaks in event listeners
- Fixed empty field selection bug

**Week 2: Performance & Code Quality**
- Implemented debounced re-rendering (85% fewer DOM queries)
- Added DOM element caching
- Standardized error handling with error codes
- Added 30+ JSDoc comments for better IDE support

**Week 3: Feature Enhancements**
- Undo/Redo with 50-action history
- Save/Load configuration support
- Field search/filter for large schemas
- HTML compression (30-40% smaller files)

**Also:**
- Renamed "Tanzu Platform" → "TP" throughout
- Consolidated documentation
- Added debug console helper
- Improved error messages

### v1.0 - Initial Release
- Visual entity builder
- Automatic relationship detection
- Multiple display modes
- Custom GraphQL queries
- Schema discovery tool

---

## 🆘 Getting Help

### Quick Reference

| Topic | Section |
|-------|---------|
| **Getting started** | Quick Start (above) |
| **Common problems** | Troubleshooting |
| **Advanced usage** | Advanced Features |
| **Technical details** | IMPROVEMENTS_SUMMARY.md |

### Support Workflow

1. Check **Troubleshooting** section
2. Use **Debug Console** helper
3. Check browser console for errors
4. Review **Debug Checklist**
5. Consult **IMPROVEMENTS_SUMMARY.md** for technical details

---

## 🎓 Learning Resources

### Understanding GraphQL Entity Queries

TP uses GraphQL with a specific entity query pattern:

```graphql
query GetEntities($first: Int!, $entityType: [String!]) {
  entityQuery {
    queryEntities(first: $first, entityType: $entityType) {
      totalCount
      entities {
        # Fields go here
      }
    }
  }
}
```

### Entity Type Naming Convention

**Schema Name:** `Entity_Tanzu_Portfolio_Space_Type`
**Query Name:** `Tanzu.Portfolio.Space`

The builder converts between these automatically. Use the query name when selecting entities.

### Field Access Patterns

```graphql
# Basic fields
entityId
entityName
entityType

# Tags (key-value pairs)
tags {
  key
  value
}

# Properties (name-value pairs)
properties {
  name
  value
}

# Namespaces (grouped properties)
namespaces {
  name
  properties {
    name
    value
  }
}
```

---

## 📝 Notes

- Reports are **self-contained HTML** files - all code embedded
- Generated reports **fetch live data** each time they load
- Schema discovery needs to be re-run if entity types change
- Saved configurations are **version-specific** to your schema
- The builder **never stores your data** - only config state

---

**Built for TP users • v2.0 • 2025-11-14**

*No server • No dependencies • Runs in your browser*
