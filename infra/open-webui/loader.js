// Inject "API Settings" link into the Open WebUI profile dropdown, before "About".
(function () {
  var LINK_ID = 'custom-api-settings-link';

  function tryInject() {
    if (document.getElementById(LINK_ID)) return;

    // Find all buttons in the page
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      // Match only the standalone "About" menu item (not buttons containing "About" as part of longer text)
      if (btn.textContent.trim() !== 'About') continue;

      var parent = btn.parentElement;
      if (!parent) continue;

      var a = document.createElement('a');
      a.id = LINK_ID;
      a.href = '/auth/user-settings?return=' + encodeURIComponent(window.location.origin + '/chat?session=main');
      // Copy all classes from the About button so the style matches exactly
      a.className = btn.className;
      // Ensure it renders as a flex row and not styled as a plain link
      a.style.cssText = 'display:flex;align-items:center;gap:inherit;text-decoration:none;color:inherit;width:100%;cursor:pointer;';

      // Replace the About button's inner content: swap icon + swap label text
      var inner = btn.innerHTML;
      // Swap label text "About" → "API Settings"
      inner = inner.replace(/>About</, '>API Settings<');
      // Swap the SVG icon for a gear icon
      inner = inner.replace(/<svg[\s\S]*?<\/svg>/, GEAR_SVG);
      a.innerHTML = inner;

      parent.insertBefore(a, btn);
      return;
    }
  }

  var GEAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:1em;height:1em;flex-shrink:0"><path fill-rule="evenodd" d="M11.078 2.25c-.917 0-1.699.663-1.85 1.567L9.05 4.889c-.02.12-.115.26-.297.348a7.493 7.493 0 0 0-.986.57c-.166.115-.334.126-.45.083L6.3 5.508a1.875 1.875 0 0 0-2.282.819l-.922 1.597a1.875 1.875 0 0 0 .432 2.385l.84.692c.095.078.17.229.154.43a7.598 7.598 0 0 0 0 1.139c.015.2-.059.352-.153.43l-.841.692a1.875 1.875 0 0 0-.432 2.385l.922 1.597a1.875 1.875 0 0 0 2.282.818l1.019-.382c.115-.043.283-.031.45.082.312.214.641.405.985.57.182.088.277.228.297.35l.178 1.071c.151.904.933 1.567 1.85 1.567h1.844c.916 0 1.699-.663 1.85-1.567l.178-1.072c.02-.12.114-.26.297-.349.344-.165.673-.356.985-.57.167-.114.335-.125.45-.082l1.02.382a1.875 1.875 0 0 0 2.28-.819l.923-1.597a1.875 1.875 0 0 0-.432-2.385l-.84-.692c-.095-.078-.17-.229-.154-.43a7.614 7.614 0 0 0 0-1.139c-.016-.2.059-.352.153-.43l.84-.692c.708-.582.891-1.59.433-2.385l-.922-1.597a1.875 1.875 0 0 0-2.282-.818l-1.02.382c-.114.043-.282.031-.449-.083a7.49 7.49 0 0 0-.985-.57c-.183-.087-.277-.227-.297-.348l-.179-1.072a1.875 1.875 0 0 0-1.85-1.567h-1.843ZM12 15.75a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z" clip-rule="evenodd"/></svg>';

  var observer = new MutationObserver(tryInject);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
