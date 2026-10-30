/**
 * SOMP Vanguard Documentation Portal Application Script
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const navTabs = document.querySelectorAll('.nav-tab-btn');
  const viewContainers = document.querySelectorAll('.view-container');
  const sidebarLinks = document.querySelectorAll('.nav-link');
  const searchBoxBtns = document.querySelectorAll('.search-trigger');
  const searchModal = document.getElementById('searchModal');
  const modalSearchInput = document.getElementById('modalSearchInput');
  const searchResultsList = document.getElementById('searchResultsList');
  const sidebarSearchInput = document.getElementById('sidebarSearchInput');
  const toastContainer = document.getElementById('toastContainer');
  const faqFilterBtns = document.querySelectorAll('.faq-filter-btn');
  const faqCards = document.querySelectorAll('.faq-card');

  // Search Index Data
  const searchIndex = [];

  // Index all chapters and sections
  document.querySelectorAll('.doc-chapter, .doc-section, .doc-subsection').forEach(section => {
    const titleEl = section.querySelector('h1, h2, h3, h4');
    const pEl = section.querySelector('p');
    if (titleEl && section.id) {
      searchIndex.push({
        id: section.id,
        view: 'docs',
        title: titleEl.textContent.replace(/#/g, '').trim(),
        snippet: pEl ? pEl.textContent.slice(0, 120) + '...' : '',
        chapter: section.closest('.doc-chapter')?.querySelector('h2')?.textContent.trim() || '使用手冊'
      });
    }
  });

  // Index Troubleshooting FAQ items
  faqCards.forEach((card, idx) => {
    const titleEl = card.querySelector('.faq-card-title');
    const bodyEl = card.querySelector('.faq-card-body');
    const tagEl = card.querySelector('.faq-tag');
    if (titleEl) {
      searchIndex.push({
        id: 'faq-' + idx,
        view: 'troubleshooting',
        title: titleEl.textContent.trim(),
        snippet: bodyEl ? bodyEl.textContent.slice(0, 120) + '...' : '',
        chapter: '故障排查 FAQ [' + (tagEl ? tagEl.textContent.trim() : '通用') + ']'
      });
    }
  });

  // Switch View Function
  window.switchView = function(viewId, targetHash = null) {
    // Determine effective view
    let targetView = viewId;

    // Update nav tabs
    navTabs.forEach(tab => {
      if (tab.dataset.view === targetView) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    // Update view containers
    viewContainers.forEach(container => {
      if (container.id === targetView + '-view') {
        container.classList.add('active');
      } else {
        container.classList.remove('active');
      }
    });

    // Scroll handling
    if (targetHash) {
      setTimeout(() => {
        const targetElement = document.getElementById(targetHash.replace('#', ''));
        if (targetElement) {
          targetElement.scrollIntoView({ behavior: 'smooth' });
        }
      }, 100);
      history.replaceState(null, '', targetHash);
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      history.replaceState(null, '', '#' + targetView);
    }
  };

  // Attach nav tab clicks
  navTabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(tab.dataset.view);
    });
  });

  // Handle URL hash on initial load
  function handleInitialHash() {
    const hash = window.location.hash;
    if (hash) {
      if (hash === '#landing') {
        switchView('landing');
      } else if (hash === '#api' || hash === '#api-explorer') {
        switchView('api');
      } else if (hash === '#troubleshooting' || hash === '#faq') {
        switchView('troubleshooting');
      } else {
        // Assume it's a doc section
        switchView('docs', hash);
      }
    }
  }
  handleInitialHash();

  // Sidebar navigation click
  sidebarLinks.forEach(link => {
    link.addEventListener('click', () => {
      sidebarLinks.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });

  // Code Copy Buttons
  document.querySelectorAll('.btn-copy-code').forEach(button => {
    button.addEventListener('click', () => {
      const wrapper = button.closest('.code-block-wrapper');
      const code = wrapper ? wrapper.querySelector('pre code') : null;
      if (code) {
        const text = code.innerText;
        navigator.clipboard.writeText(text).then(() => {
          showToast('代碼已複製至剪貼簿！');
          const originalText = button.innerHTML;
          button.innerHTML = '<span>✓ 已複製</span>';
          setTimeout(() => {
            button.innerHTML = originalText;
          }, 2000);
        }).catch(err => {
          console.error('Copy failed:', err);
        });
      }
    });
  });

  // Toast Notification
  window.showToast = function(message) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      <span>${message}</span>
    `;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  };

  // Search Modal Trigger
  searchBoxBtns.forEach(btn => {
    btn.addEventListener('click', openSearchModal);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openSearchModal();
    }
    if (e.key === 'Escape' && searchModal.classList.contains('active')) {
      closeSearchModal();
    }
  });

  function openSearchModal() {
    searchModal.classList.add('active');
    modalSearchInput.value = '';
    modalSearchInput.focus();
    renderSearchResults('');
  }

  function closeSearchModal() {
    searchModal.classList.remove('active');
  }

  searchModal.addEventListener('click', (e) => {
    if (e.target === searchModal) {
      closeSearchModal();
    }
  });

  modalSearchInput.addEventListener('input', (e) => {
    renderSearchResults(e.target.value.trim().toLowerCase());
  });

  function renderSearchResults(query) {
    searchResultsList.innerHTML = '';
    if (!query) {
      searchResultsList.innerHTML = '<li style="padding: 16px; text-align: center; color: var(--text-dim);">輸入關鍵字進行全文搜尋... (例如: RBAC, CMDB, Drift, Nutanix, SSL, Proxy, 排程)</li>';
      return;
    }

    const filtered = searchIndex.filter(item => 
      item.title.toLowerCase().includes(query) ||
      item.snippet.toLowerCase().includes(query) ||
      item.chapter.toLowerCase().includes(query)
    );

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    if (filtered.length === 0) {
      searchResultsList.innerHTML = `<li style="padding: 16px; text-align: center; color: var(--text-dim);">找不到與「${escapeHtml(query)}」相關的內容</li>`;
      return;
    }

    filtered.slice(0, 10).forEach(item => {
      const li = document.createElement('li');
      li.className = 'search-result-item';
      li.innerHTML = `
        <div class="result-chapter">${escapeHtml(item.chapter)}</div>
        <div class="result-title">${escapeHtml(item.title)}</div>
        <div class="result-snippet">${escapeHtml(item.snippet)}</div>
      `;
      li.addEventListener('click', () => {
        closeSearchModal();
        if (item.view === 'troubleshooting') {
          switchView('troubleshooting');
        } else {
          switchView('docs', '#' + item.id);
        }
      });
      searchResultsList.appendChild(li);
    });
  }

  // Sidebar Filter Input
  if (sidebarSearchInput) {
    sidebarSearchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      sidebarLinks.forEach(link => {
        const text = link.textContent.toLowerCase();
        const listItem = link.closest('li');
        if (listItem) {
          listItem.style.display = text.includes(term) ? 'block' : 'none';
        }
      });
    });
  }

  // IntersectionObserver for Sidebar Active Sync
  const headings = document.querySelectorAll('.doc-chapter, .doc-section');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        if (id) {
          sidebarLinks.forEach(link => {
            if (link.getAttribute('href') === '#' + id) {
              sidebarLinks.forEach(l => l.classList.remove('active'));
              link.classList.add('active');
            }
          });
        }
      }
    });
  }, {
    rootMargin: '-80px 0px -70% 0px'
  });

  headings.forEach(heading => observer.observe(heading));

  // Troubleshooting FAQ Filter & Accordion
  faqFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      faqFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const category = btn.dataset.category;

      faqCards.forEach(card => {
        if (category === 'all' || card.dataset.category === category) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    });
  });

  faqCards.forEach(card => {
    const header = card.querySelector('.faq-card-header');
    if (header) {
      header.addEventListener('click', () => {
        card.classList.toggle('open');
      });
    }
  });
});
