import React from 'react';
import { createRoot } from 'react-dom/client';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import { App } from './App';
import './style.css';

const theme = createTheme({
  palette: {
    primary: { main: '#176657' },
    background: { default: '#f6f7f5', paper: '#fff' },
    text: { primary: '#17332e', secondary: '#73817b' },
    warning: { main: '#ae6e13' },
    error: { main: '#bc4542' },
  },
  typography: {
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    button: { textTransform: 'none', fontWeight: 600 },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiTableCell: { styleOverrides: { root: { borderColor: '#edf0eb' } } },
    MuiChip: { styleOverrides: { root: { fontWeight: 600, fontSize: 12 } } },
    MuiTextField: { defaultProps: { size: 'small' } },
  },
});
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
